# ADR-007: pgvector + Local Transformers.js MiniLM Embeddings over a Dedicated Vector DB and Hosted Embeddings

**Date**: 2026-11-19
**Status**: Accepted
**Phase**: 3
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 3 needs vector similarity for memory retrieval, which is really **two** coupled decisions:

1. **Where do vectors live?** Postgres already houses chat state (Redis) and will house memory rows; a dedicated vector store is a candidate.
2. **Who produces embeddings?** The original plan sketched a `vector(1536)` column, which silently assumed a hosted 1536-dim embedding model (OpenAI text-embedding-3-small class).

Constraints discovered before this ADR was written:

- **Generation remains Ollama Cloud `glm-5.3-flash`** — that contract is fixed and untouched.
- The [Ollama Cloud embedding catalog](https://ollama.com/search?c=cloud&c=embedding) currently shows **no embedding models** (checked 2026-11-19). Ollama's OpenAI-compatible `/v1/embeddings` endpoint [is documented](https://docs.ollama.com/api/openai-compatibility), but the cloud catalog has nothing to call it with today.
- Embedding dimension is not mix-and-match: the column type, index, and the model are one contract. Changing the model later means re-embedding everything and a migration.

---

## Problem

Which vector store and which embedding model, such that retrieval works, costs nothing per call, keeps memory content private, and stays honest when the provider is unavailable?

---

## Options Considered

### Option A — Dedicated vector DB (Pinecone / Milvus) + hosted embeddings (OpenAI / Cohere)

**Description**: Standard 2026 startup stack: managed vector index, 1536-dim hosted embeddings.

**Pros**:
- Best raw retrieval quality at scale; managed infra; long-context embedding models.
- No local compute for embedding.

**Cons**:
- A second database with its own account, latency, failure mode — on top of Postgres + Redis we already run.
- **Memory content leaves the machine** — agent memories (research notes, corrections) are exactly the data this project treats as private.
- Per-call cost for every write and every query; Ollama Cloud already proves paid APIs are manageable, but a second vendor + key for a portfolio demo is sprawl.
- 1536-dim vectors: 4× the storage/index width of 384-dim for the same volume.

### Option B — Postgres pgvector + local Transformers.js MiniLM (chosen)

**Description**: Vectors live in the same Postgres as memory rows (Prisma **6.19.3**, [pgvector](https://github.com/pgvector/pgvector), `vector(384)`, HNSW cosine index). Embeddings computed locally by Node Transformers.js (`@huggingface/transformers`) with `Xenova/all-MiniLM-L6-v2` — [model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2): output `[N, 384]`, mean pooling + normalized, Apache-2.0.

**Pros**:
- One database. The vector index sits next to the rows it scores; pgvector HNSW cosine does candidate recall, exact rescoring happens in process.
- Content never leaves the machine; no second vendor, no second API key, zero per-embedding cost.
- Model downloads on first use into a project-local ignored cache; afterwards the pipeline runs **offline**.
- `Xenova/all-MiniLM-L6-v2` is a tiny, well-documented, Apache-2.0 model — pinned and reproducible.

**Cons**:
- 384-dim retrievals are weaker than 1536-class hosted models; acceptable at portfolio scale, a real ceiling to revisit if memory grows orders of magnitude.
- CPU inference latency per embed (batched, and off the request path — embedding is async by design).
- Local model cache must stay ignored and pinned; a fresh clone re-downloads on first run.

### Option C — pgvector + Ollama embeddings

**Description**: Keep one vendor: call Ollama's documented embeddings capability.

**Pros**:
- Same provider as generation; the `/v1/embeddings` route is OpenAI-compatible and documented.

**Cons**:
- The **Ollama Cloud embedding catalog currently shows no models** (checked 2026-11-19) — the cloud plan we use has nothing to embed with.
- A self-hosted Ollama server would add the exact local-ops burden Option B avoids, while still being a second model to pin. Rejected; revisit if Ollama Cloud ships embedding models.

---

## Decision

We chose **Option B**: Postgres 16 + Prisma 6.19.3 + pgvector with a `vector(384)` column and an HNSW cosine candidate index; local `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2`, mean pooling + L2-normalized output. **The same model embeds writes and queries.** First use downloads the model to a project-local ignored cache; later embedding runs offline.

**The original `vector(1536)` sketch is deliberately superseded** by this decision: the chosen local model emits 384.

**Honesty boundary**: deterministic/mock embeddings exist **only in tests**. Production never writes placeholder vectors, and a failed embedding job leaves the block in a visible `failed` state (path-queryable, retryable) — a queue failure never masquerades as a ready embedding.

---

## Consequences

### Positive

- Single-database memory: Prisma migrations carry the vector column; no extra service in docker-compose beyond a pgvector-enabled Postgres (joining Redis).
- Privacy and cost: memory content and every embedding stay local; no per-call embedding spend.
- Offline-capable pipeline after first-run model download; deterministic local embedding behavior per pinned model.
- pgvector HNSW gives candidate recall adequate for portfolio-scale memory; exact scoring (cosine + recency) happens in our code, where it stays explainable.

### Negative

- 384 dims: lower retrieval ceiling than 1536-dim hosted models; the index and column are dimension-bound to this model.
- First run downloads the model (network needed once); CI/fresh environments must tolerate or pre-seed that cache.
- Embedding throughput is CPU-bound; large backfills need batching and are inherently async.

### Risks / Open questions

- Model revision pinning: the model card documents `[N, 384]` today; any revision bump re-verifies dimension and pooling before it is adopted.
- Switching the embedding model later = full re-embed + migration. Deliberately accepted; the dimension is a one-way door for a given dataset.

---

## Validation

- Local smoke: real `Xenova/all-MiniLM-L6-v2` embed → exactly 384 dims, normalized.
- Integration: real Postgres + pgvector with deterministic mock embeddings → cosine candidates match an in-process reference computation; HNSW index used.
- Live gate (Phase 3): semantic search returns a genuinely relevant result after a real write → embed → search round-trip; an embedding failure is explicit (`failed` status), never silent.

---

## References

- [pgvector](https://github.com/pgvector/pgvector)
- [Xenova/all-MiniLM-L6-v2 model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
- [Ollama — Embeddings capability](https://docs.ollama.com/capabilities/embeddings)
- [Ollama — OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama Cloud — embedding catalog](https://ollama.com/search?c=cloud&c=embedding)
- [Prisma docs](https://www.prisma.io/docs)
