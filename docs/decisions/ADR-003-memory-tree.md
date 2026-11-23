# ADR-003: Memory Tree + Typed Relations + LLM Compaction over Flat Memory (and over a Graph DB)

**Date**: 2026-11-19
**Status**: Accepted
**Phase**: 3
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 3 builds the memory system (`packages/core/memory/`). The requirements it must survive:

- Memory has to stay useful **past ~50 blocks**. A naive append-only list degrades: queries return long undifferentiated dumps, stale lessons sit next to fresh corrections at equal weight.
- Some blocks are *logically connected* to others: a correction fixes an earlier learning; a later decision supports an earlier observation. That connection is information.
- Memory grows unboundedly while agents run. Something must bound it — deletion loses history, which is the wrong trade for a system meant to learn and be audited.
- v1 is a single-tenant portfolio demo, but the shape should not force a rewrite when tenancy arrives later.

---

## Problem

How do we address, relate, and bound memory blocks so retrieval stays sharp past 50 entries — flat list, hierarchical tree, or a graph database?

---

## Options Considered

### Option A — Flat list of blocks

**Description**: One table, every block an unordered row. Retrieval = semantic search over all blocks.

**Pros**:
- Simplest possible schema; nothing to get wrong about naming.
- Search works identically regardless of organization.

**Cons**:
- Collapses in practice around block 50: no scoping, no prefix browsing, no natural "where would this go?" discipline.
- No per-path growth control — compaction can only mean global pruning.
- Every query competes with the entire corpus; the semantic needle hides in an ever-bigger haystack.

### Option B — Hierarchical path tree + typed relations + async LLM compaction (chosen)

**Description**: Blocks live at **domain-neutral slash paths** (e.g. `research/small-language-models`) within a single-tenant `scope = default`. Typed relations (`supports / supersedes / contradicts`) connect blocks without becoming rows. When active blocks at an exact path exceed **30**, an async job compacts the oldest 30 into one summary block (metadata `compactedFromIds`) and marks the sources superseded — retained, excluded by default.

**Pros**:
- Prefix browsing: everything under `research/` is one query; the path tree is the browse index.
- Typed relations give graph-like traversal (an agent can walk "what supports this?") without a second database.
- Compaction bounds growth per path while **keeping** the sources (audit trail survives even after compaction).
- `scope` as a column means a future multi-tenant change is a field change, not a migration.

**Cons**:
- Path naming discipline is on us: paths must stay domain-neutral (no brands) and reasonably regular, or browse quality decays.
- Compaction quality depends on the LLM; a bad summary is cheap to detect (non-empty, ≤1000 chars) but not free to prevent.
- Superseded blocks are retained, so storage grows even after compaction; "retain but exclude" is a deliberate cost.

### Option C — Graph database (Neo4j et al.)

**Description**: Blocks and relations live natively as nodes/edges; relations are first-class.

**Pros**:
- Deep, arbitrary graph traversal is the native query mode.
- Relations are schema-enforced rather than convention.

**Cons**:
- A second database to run, migrate, and back up — for a workload whose *primary* access pattern is vector + path queries, not multi-hop graph walks.
- The Postgres row we need anyway (content, embedding, confidence) would be duplicated or split across systems.
- Portfolio-relevant complexity without a matching Phase 3 requirement: we need *relations on blocks*, not a knowledge graph engine.

---

## Decision

We chose **Option B** on Postgres + Prisma + pgvector (storage decision in [ADR-007](./ADR-007-pgvector.md)): hierarchical domain-neutral slash paths, typed `supports / supersedes / contradicts` relations, superseded blocks retained and excluded by default, and async LLM compaction triggered when active blocks at an exact path exceed 30 — one learning block per compaction, `compactedFromIds` metadata, sources never deleted.

Relations live in a join structure on the same Postgres rows as the blocks. No graph database: the relationships we care about in Phase 3 are shallow (who does this block supersede/support/contradict?), traversable with simple joins, not with a graph engine.

---

## Consequences

### Positive

- Path tree + prefix browse + hybrid search (see the phase doc) keeps recall sharp past 50 entries.
- Compaction caps per-path growth; retained superseded sources make every compaction auditable and reversible-by-inspection.
- Relations are explicit and queryable — correction flows ("what does this supersede?") survive.
- Single-database ops: memory is just more Prisma models with a vector column.

### Negative

- Path vocabulary becomes part of the product contract; naming drift directly hurts browse quality.
- Compaction is async and LLM-mediated: its output is unverified text until validated (non-empty, ≤1000 chars) and embedded like any write.
- Superseded retention grows storage forever; if it becomes a problem, a later phase earns the retention-policy ADR.

### Risks / Open questions

- Relation cycles (`A supports B`, `B contradicts A`) are legitimate; traversal must terminate regardless. Explore-related endpoints depth-bound rather than exhaust.
- Compaction triggering is per **exact path** — very deep paths compact independently; very busy broad paths (e.g. `research/`) hold more than 30 active blocks legitimately. Watch real usage before adding hierarchical counting.

---

## Validation

- Service tests with **>50 entries** at one path: compaction fires, produces one valid summary block, sources retained and excluded by default.
- In-memory store concurrency tests: duplicate compaction jobs cannot interleave; retried embed jobs are idempotent.
- Live gate (Phase 3): correction supersedes its source and disappears from default queries; relations are explorable via the related endpoint; semantic results remain relevant after compaction.

---

## References

- [Phase 3 — Memory, Embeddings, Hybrid Search](../phases/phase-3-memory.md)
- [ADR-007: pgvector + local MiniLM embeddings](./ADR-007-pgvector.md)
- [pgvector](https://github.com/pgvector/pgvector)
