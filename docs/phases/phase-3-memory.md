# Phase 3 — Memory, Embeddings, Hybrid Search

**Duration**: 1-2 weeks
**Goal**: Build a memory system that survives past 50 entries — hierarchical, vector-searchable, LLM-compactable.

> **Status: 🚧 Active — implementation complete, automated + real-service validation green, live gate pending (started 2026-11-19, last updated 2026-11-19).** Phase 2 validated 2026-11-19 and Farhan said "next"; this phase began the same day. Everything below is **implemented** (core memory + Prisma pgvector adapter + migrations, API memory routes + queue + worker + local embeddings, web `/memory` page, docker-compose Postgres/pgvector) with **339 offline tests green** (core 131, CLI 30, API 133, web 45). The automated real-stack validation is also green (see *Validation evidence*): real Postgres/pgvector+BullMQ integration 14/14 twice, real local-embedding smoke 5/5 twice (real HuggingFace download into the project cache), plus a real-service browser smoke and the `demo:memory` seeder. **The phase is still NOT complete**: compaction by the REAL Ollama model has not been run (the browser smoke used a dummy key), and the phase remains incomplete until Farhan explicitly approves the live gate.
> The design below is **fixed**, not open for re-litigation. It is recorded as decisions in [ADR-003](../decisions/ADR-003-memory-tree.md) (memory tree + relations + compaction) and [ADR-007](../decisions/ADR-007-pgvector.md) (pgvector + local MiniLM embeddings, `vector(384)`).

---

## What gets built in this phase

"All built" summary (implementation is in place; validation still pending):

`packages/core/memory/` — domain contracts and `MemoryService`:

- Public API: `writeBlock / queryBlocks / semanticSearch / exploreRelated` ✅
- Embedding and compaction processing methods (async job handlers) ✅
- In-memory store for unit tests; Prisma Postgres/pgvector adapter + migrations for the real store ✅
- BullMQ `memory` queue (embedding + compaction jobs) on the existing Redis ✅ (lives in `apps/api/src/memory`)
- Apps integration ✅: REST routes in `apps/api`, the `/memory` page in `apps/web`

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 3.1 | Embeddings — vectors, cosine similarity | _ | |
| 3.2 | Embedding models (local Transformers.js/MiniLM vs hosted; dimensionality) | _ | |
| 3.3 | Vector databases (pgvector vs. Pinecone vs. Milvus — pgvector chosen) | _ | |
| 3.4 | Hybrid search (semantic + keyword + recency fusion) | _ | |
| 3.5 | RAG pattern (chunking, retrieval, prompt augmentation) | _ | |
| 3.6 | Memory architectures (flat vs. tree vs. graph) | _ | |
| 3.7 | Compaction & pruning (LLM summarization, half-lives) | _ | |

---

## Fixed design

### Memory model

| Concern | Decision |
|---|---|
| Scope | Single-tenant; every block carries `scope = default` (a field, so tenancy later is a change not a migration) |
| Addressing | Domain-neutral slash paths, e.g. `research/small-language-models` — **never brand paths**. Prefix browse: `queryBlocks({ path: 'research' })` sees the subtree |
| Kinds | `learning \| correction \| changelog \| observation \| decision \| preference` |
| Content | Plain text, 1..1000 chars |
| Confidence | 0..1 |
| Relations | Typed: `supports / supersedes / contradicts` — a correction supersedes the learning it fixes |
| Superseded blocks | **Retained** (audit trail) but excluded by default from queries/search; opt in via `includeSuperseded` |
| Status | `pending` (written) → `ready` (embedded) or `failed` (visible). Only `ready` enters semantic search; `pending`/`failed` stay path/keyword-queryable |

### Storage — Postgres + Prisma + pgvector

- Postgres 16, Prisma **6.19.3**, pgvector extension, `vector(384)` column, HNSW cosine index for candidate recall.
- The original `vector(1536)` plan is **deliberately superseded**: the chosen embedding model emits 384 (ADR-007).

### Embeddings — local Transformers.js

- `@huggingface/transformers`, model `Xenova/all-MiniLM-L6-v2` — model card documents `[N, 384]` output, mean pooling + normalized, Apache-2.0.
- Mean pooling + L2 normalization → 384-dim vectors. **The same model embeds writes and queries** — mixing models breaks the vector space.
- First use downloads the model to a project-local ignored cache; afterwards the pipeline is offline.
- Generation stays Ollama Cloud `glm-5.3-flash`. The Ollama Cloud embedding catalog currently shows no models (checked 2026-11-19): **no second hosted key, and no fake embeddings in production** — deterministic mock embeddings exist only inside tests.

### Async pipeline — BullMQ on the existing Redis

- Queue `memory`, jobs: **embedding and compaction only** (scheduled agents remain Phase 5).
- **Deterministic job IDs** (derived from block/compaction identity), bounded attempts with exponential backoff, **idempotent workers** — a retried job cannot double-embed or double-compact.
- Failures stay visible: a failed embedding leaves the block `failed` and path-queryable. **A queue failure never masquerades as ready.**
- The worker starts **within the API process** for now; separate scheduler/worker topology arrives later (Phase 5).

### Hybrid search — two phases

1. **Candidate recall**: pgvector HNSW cosine top-k over `ready` embeddings.
2. **Exact score** on the candidates: `score = 0.8 × cosineSimilarity + 0.2 × recencyDecay`, with `recency = 0.5^(ageDays / kindHalfLife)`.

Per-kind half-lives (days, fixed and documented):

| Kind | Half-life |
|---|---|
| learning | 30 |
| correction | 90 |
| changelog | 180 |
| observation | 14 |
| decision | 180 |
| preference | 90 |

- **Keyword filtering is a `queryBlocks` capability, not part of the 0.8/0.2 formula.** `semanticSearch` = cosine candidates + the two-term exact score.
- Stable deterministic tie-break: newest first, then block id.
- `queryBlocks` independently supports `path` (prefix), `kind`, `keyword`, `limit`, `includeSuperseded` — no embeddings required.

### Compaction

When **active** (non-superseded) blocks at an **exact path** exceed **30**:

1. An async `compact` job takes the **oldest 30 active** blocks at that path.
2. Ollama Cloud `glm-5.3-flash` via AI SDK `generateText` — plain text, **no structured output** — produces a summary.
3. Validate the summary: non-empty, ≤1000 chars, plain text. Invalid → job fails (retryable); sources untouched.
4. One transaction: insert a new `learning` block with `compactedFromIds` metadata and mark the 30 sources superseded, linked to it.
5. The summary block is embedded asynchronously like any write.
6. Concurrency/duplicate-job protection — two compactions of the same path cannot interleave. **Sources are never deleted.**

### REST routes (implemented — validation pending)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/memory/blocks` | Create a block (optionally superseding one); enqueue its embed job |
| GET | `/api/memory/blocks` | Browse: `path` (prefix), `kind`, `keyword`, `limit`, `includeSuperseded`, newest first |
| POST | `/api/memory/search` | Semantic search (cosine + recency score per block) |
| GET | `/api/memory/blocks/:id/related` | Relations traversal (`{ block, outgoing, incoming }`) |
| POST | `/api/memory/blocks/:id/retry` | Re-queue a failed/pending block's embedding |
| POST | `/api/memory/compact` | Trigger compaction for an exact path |

Safe errors: 400 invalid payload, 404 unknown id/path, 409 conflict (duplicate idempotent send, retry of a `ready` block, compaction already running), 503 Postgres/queue/model unavailable. **No block content in logs, no secrets in logs.**

### Chat stays unchanged in Phase 3

No automatic memory writes, no memory results injected into chat prompts — the memory tool/capability composition arrives in Phase 4. The chat agent keeps **exactly one tool: `calculate`**.

### Web page (implemented — validation pending)

The accessible `/memory` page: create a block; path/keyword browse; semantic search showing cosine, recency, score and status; related/superseded display; retry a failed block; compact a path. The chat UI is untouched.

### Infrastructure (implemented — app containers stay Phase 6)

`docker-compose.yml` now runs the Phase 2 Redis **and** the Phase 3 Postgres with pgvector (`pgvector/pgvector:pg16`, local db/user/password all `workforce`, host port bounded to `127.0.0.1:55432` (→ container 5432), named `postgres-data` volume, `pg_isready` healthcheck):

```sh
npm run dev:infra                # docker compose up -d redis postgres
npm run db:migrate               # npx prisma migrate deploy --schema packages/core/prisma/schema.prisma (local Prisma 6.19.3, no npx download)
```

`DATABASE_URL` defaults to `postgresql://workforce:workforce@127.0.0.1:55432/workforce` (overridable by env) so local dev starts without config. The default is localhost-only with throwaway credentials — **the Phase 6 deployment must set an explicit secret URL**, never this default. The migration runs automatically before `npm run dev` (root `predev`) and is never run by the API process itself.

### Explicit non-goals (Phase 3)

No deployment, no auth, no multi-tenant SaaS, no graph DB, no Pinecone/Milvus/ClickHouse, no MCP, no scheduled agents (Phase 5), no memory-driven chat behavior (Phase 4).

---

## Tests

- **Offline, pure**: validation, ranking, and service logic with >50 entries; in-memory store — concurrency, compaction, retries (mock embeddings, mocked model).
- **Integration**: real Postgres with pgvector + real BullMQ/Redis; deterministic mock embeddings and model.
- **Smoke**: real local MiniLM 384-dim embedding; browser UI smoke on `/memory`.

Current state (2026-11-19):

- Offline suites green: **339 tests** (core 131, CLI 30, API 133, web 45).
- Real Postgres/pgvector + real BullMQ/Redis integration (`test-live/`): **14/14 twice consecutively** — pending→ready pipeline across >50 run-scoped blocks, strict query/semantic behavior with exact 0.8/0.2 fields and no vectors, corrections + related graph, fresh-service persistence proof, queue retry (fail 2 → succeed 3rd, exactly 3 calls), exhausted-job + deterministic requeue, 31-block compaction (one summary, 30 sources retained + superseded, active 2, summary ready), concurrent duplicate-trigger compaction with no duplicate and independent Prisma reads under the session lock.
- Real local embedding smoke (`npm run test:embedding`): **5/5 twice** (384 finite, unit norm, byte-for-byte determinism, robust relevance; first run downloaded the real MiniLM q8 model into the project cache; native onnxruntime-node runs).

### Real-service browser smoke (dummy key — recorded 2026-11-19, no real Ollama call)

With the real API + web stack running against the local Postgres/Redis and a **dummy `OLLAMA_API_KEY`**: created observations showed `pending` → `ready` through the queue/worker; semantic search returned sensible rankings (example: cosine 0.557, recency 1.0, final score 0.646); a correction superseded its target and the `/memory` page showed the outgoing related edge with the full superseded block; the page passed a desktop/mobile accessibility pass with zero missing accessible names. **Limitation**: with the dummy key the real Ollama compaction and real chat streaming could not succeed — those remain on the live gate.

### Live demo seeder (`npm run demo:memory`)

`apps/api/scripts/seed-memory-demo.ts` drives the RUNNING API over plain HTTP (it reads no Ollama key): it refuses a partially-seeded `DEMO_PATH`, seeds 31 observation blocks (real local-MiniLM embeddings), the 31st triggers the real server-side Ollama compaction, and it polls bounded (180s/2s) until the 30-source learning summary is ready. Sources stay in place for UI inspection; details in `apps/api/README.md`.

**Live finding + fix (2026-11-22):** the first real run (`scope=demo`, `path=compaction/small-models`, 31 ready blocks) produced no summary — the BullMQ compact job failed all 3 attempts, each burning the full 120s `AbortSignal` budget on the provider's always-on reasoning. Fix: the compactor now sends `providerOptions {ollama: {reasoningEffort: 'low'}}` (the documented minimal effort — `none` is unsupported), `maxOutputTokens: 2000`, `temperature: 0.2` (mock-tested; 120s bound and no-tools contract unchanged). **Not yet verified live.** The seeder is now RESUMABLE: rerunning `npm run demo:memory` on the existing 31-ready/no-summary state queues exactly one fresh compaction (new trigger, no new blocks); a pending/failed summary gets only its embedding requeued; a ready summary reports success immediately. The low-reasoning compaction still needs Farhan's live run.

---

## Validation gate for Phase 3 (live)

1. Write a block → status `pending` → `ready`. *(covered by integration + browser smoke)*
2. Restart the API — memory survives (Postgres, not process memory). *(persistence proven via a fresh Prisma/store instance in the integration run; a live restart walkthrough is part of Farhan's gate)*
3. Semantic search returns a result that is actually relevant. *(covered)*
4. A correction supersedes the block it corrects; the superseded one drops from default queries. *(covered)*
5. Relations are explorable — `supports` / `supersedes` / `contradicts`. *(supersedes covered by integration + browser smoke)*
6. >30 blocks at a path → compaction produces a summary; the 30 sources are retained. *(automated compaction proven end-to-end with the mock compactor; the REAL Ollama compaction call is still pending — the first live attempt timed out on always-on reasoning and the compactor now sends `reasoningEffort: 'low'`, unverified live; run `npm run demo:memory` with your key — it is resumable on the existing 31-block state)*
7. Embedding failure and Postgres failure are **explicit** — `failed` status / 503, never silent. *(covered by offline suite; browser smoke saw honest pending states)*

**Remaining before approval**: run the demo seeder against the REAL Ollama key (real compaction summary), optionally the API-restart walkthrough, and Farhan's explicit approval of this gate. **Phase 3 is NOT complete until Farhan explicitly approves it.**

---

## When done

→ Start [Phase 4 — Multi-Agent Systems](./phase-4-multi-agent.md)
