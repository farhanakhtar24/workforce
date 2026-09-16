# Learning Curriculum

This is the master topic map for Workforce. **Do not attempt to read this all up front.** Each phase's doc lists only what that phase needs — this file exists for reference and to help future-you (or another agent) understand the full scope.

---

## Legend

- 🟢 **Confident** — I could teach this to someone else
- 🟡 **Rusty** — I've used it but need a refresher
- 🔴 **Trash** — never touched it, or only heard the word

Rate yourself per topic **at the start of the relevant phase**, not all at once.

---

## Phase 0 — Scaffolding

| # | Topic | Subtopics | Resources if 🔴 |
|---|---|---|---|
| 0.1 | TypeScript strict | Generics, unions, discriminated unions, `satisfies`, `as const` | TypeScript handbook ch. 2-4 |
| 0.2 | Node.js async model | Event loop, `setTimeout` vs `setImmediate`, streams, backpressure | Node.js guides |
| 0.3 | REST API fundamentals | Middleware, error handling, Zod | Express docs |
| 0.4 | Git workflow | Conventional commits, PR hygiene, semantic versioning | Conventional Commits spec |
| 0.5 | SQL fundamentals | Joins, indexes, GROUP BY, CTEs | SQLBolt or pgexercises |

---

## Phase 1 — LLM Core

| # | Topic | Subtopics | Resources if 🔴 |
|---|---|---|---|
| 1.1 | What an LLM actually is | Tokens, context window, temperature, top_p | "What are tokens?" — OpenAI docs |
| 1.2 | Prompt engineering | System/user/developer messages, few-shot, chain-of-thought, role prompting | Anthropic prompt engineering guide |
| 1.3 | Tool calling | JSON schema contracts, tool results fed back, parallel calls | OpenAI function calling docs, Anthropic tool use docs |
| 1.4 | Structured output | Zod → JSON schema, parsing failures, retries | Vercel AI SDK structured output docs |
| 1.5 | Tokens & cost | Input vs. output pricing, counting tokens with tiktoken, budget planning | OpenAI tokenizer page |
| 1.6 | The agent loop | Observe → Think → Act → Observe, stop conditions, step caps | "ReAct" paper (high-level skim) |
| 1.7 | Multi-turn state | Message array format, history growth, summarization strategies | Any long-context guide |

---

## Phase 2 — Streaming

| # | Topic | Subtopics | Resources if 🔴 |
|---|---|---|---|
| 2.1 | Server-Sent Events | Wire format, `text/event-stream`, EventSource | MDN SSE guide |
| 2.2 | Streaming LLM responses | Chunked output, token deltas, finish reasons | OpenAI streaming docs |
| 2.3 | Vercel AI SDK | `useChat`, `streamText`, Data Stream Protocol, UI message streams | AI SDK docs |
| 2.4 | Resumable streams | Redis checkpoints, replay semantics, TTLs | resumable-stream package README |
| 2.5 | Idempotency-Key | Redis `SET NX EX`, TTL windows, graceful degradation without Redis | Stripe idempotency docs |
| 2.6 | Mid-stream errors | AbortSignal, partial saves, cleanup hooks | Node.js stream docs |

---

## Phase 3 — Memory, Embeddings, RAG

| # | Topic | Subtopics | Resources if 🔴 |
|---|---|---|---|
| 3.1 | Embeddings | Vectors in high-D space, cosine similarity, why meaning ≈ proximity | Jay Alammar's "Illustrated Word2vec" |
| 3.2 | Embedding models | OpenAI text-embedding-3-small/large, Gemini embedding-001, Cohere | OpenAI embeddings guide |
| 3.3 | Vector databases | pgvector vs. Pinecone vs. Milvus — when each makes sense | pgvector README |
| 3.4 | Hybrid search | Semantic + keyword fusion, recency weighting, MMR | Weaviate hybrid search intro |
| 3.5 | RAG | Chunking, retrieval, prompt augmentation, eval loops | LangChain RAG guide |
| 3.6 | Memory architectures | Flat vs. tree vs. graph; why flat collapses at scale | MemGPT paper (skim) |
| 3.7 | Compaction | LLM summarization for memory pruning, relevance scoring | Helium's own memory-tree.service.ts (reference) |

---

## Phase 4 — Multi-Agent

| # | Topic | Subtopics | Resources if 🔴 |
|---|---|---|---|
| 4.1 | What an agent is | Loop + tools + memory + stop conditions | Anthropic "Building effective agents" |
| 4.2 | Capability adapters | Tool contracts, readOnlyTools, approvalPolicy | Helium capability-adapter.ts (reference) |
| 4.3 | Plan vs. Action mode | Composition-time gating, read-only subsets | Helium agent-factory.ts (reference) |
| 4.4 | Delegation patterns | Sync / async / DAG; when each | Helium delegation.service.ts (reference) |
| 4.5 | Depth capping | Why bound recursion; failure modes without it | Any distributed-systems recursion discussion |
| 4.6 | HITL | Pause points, resume semantics, approval UI | Helium cmd_ask_user pattern (reference) |
| 4.7 | Anti-patterns | Manager-does-everything, ping-pong, shared mutable memory | Multi-agent design discussions online |

---

## Phase 5 — Queues & Schedulers

| # | Topic | Subtopics | Resources if 🔴 |
|---|---|---|---|
| 5.1 | Why queues | Sync vs. async, HTTP timeout limits, long-running work | BullMQ "What is a queue" |
| 5.2 | BullMQ fundamentals | Producers, workers, job states, retries, backoff | BullMQ docs ch. 1-4 |
| 5.3 | Repeatable jobs | Cron expressions, timezone, skip-dates | BullMQ repeatable jobs guide |
| 5.4 | Two-process topology | API server vs. cron/process server, why split | Helium crons.ts (reference) |
| 5.5 | Job idempotency | Redis locks, dedupe keys, graceful re-runs | Helium insert-sequence.worker.ts (reference) |
| 5.6 | Dead Letter Queue | Failure escalation, retry exhaustion, manual replay | RabbitMQ DLX design docs |

---

## Phase 6 — Deploy & Observability

| # | Topic | Subtopics | Resources if 🔴 |
|---|---|---|---|
| 6.1 | Docker Compose | Services, volumes, networks, hot-reload | Docker Compose getting started |
| 6.2 | Structured logging | pino, JSON logs, correlation IDs, log levels | pino README |
| 6.3 | OpenTelemetry | Spans, traces, context propagation | OTel JS quickstart |
| 6.4 | Deployment targets | Railway / Render / Fly.io; managed Postgres (Neon) + Redis (Upstash) | Railway quickstart |
| 6.5 | 12-factor app | Config via env, secrets, stateless processes | 12factor.net |

---

## Study pacing guidance

Rules of thumb based on your stated 10h/week:

- 🟢 topics: **30 min review** each — skim docs, refresh mentally.
- 🟡 topics: **2-3 hours** each — focused reading + small exercise.
- 🔴 topics: **4-6 hours** each — full lesson + exercises + at least one small build.

Per phase, expect the **learn part to take 40-60% of the time** and the **build part 40-60%**.

If you consistently blow the estimate, we re-pace the roadmap (no shame — recalibrating is the point).
