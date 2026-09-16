# Phase 3 — Memory, Embeddings, Hybrid Search

**Duration**: 1-2 weeks
**Goal**: Build a memory system that survives past 50 entries — hierarchical, vector-searchable, LLM-compactable.

> Status: **Not started**. Begin after Phase 2 validation passes.

---

## What gets built in this phase

`packages/core/memory/` — path-addressed memory tree with:
- `writeBlock / queryBlocks / semanticSearch / exploreRelated`
- pgvector storage (vector(1536))
- Hybrid ranking: `0.8 * cosine + 0.2 * recency_decay`
- BullMQ-backed async embedding pipeline
- LLM-driven compaction when a path exceeds 30 blocks
- Memory kinds: `learning | correction | changelog | observation | decision | preference`

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 3.1 | Embeddings — vectors, cosine similarity | _ | |
| 3.2 | Embedding models (OpenAI, Gemini, Cohere; dims) | _ | |
| 3.3 | Vector databases (pgvector vs. Pinecone vs. Milvus) | _ | |
| 3.4 | Hybrid search (semantic + keyword + recency fusion) | _ | |
| 3.5 | RAG pattern (chunking, retrieval, prompt augmentation) | _ | |
| 3.6 | Memory architectures (flat vs. tree vs. graph) | _ | |
| 3.7 | Compaction & pruning (LLM summarization, half-lives) | _ | |

---

## Build artifact spec

*To be detailed at phase kickoff.*

---

## Validation gate for Phase 3

*To be detailed at phase kickoff.*

---

## When done

→ Start [Phase 4 — Multi-Agent Systems](./phase-4-multi-agent.md)
