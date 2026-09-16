# Workforce

> An AI workforce platform: you chat with a small team of AI agents, and they actually *do* work — running tasks on a schedule, remembering things across conversations, and delegating big jobs to each other.

Think less "chatbot", more "team".

---

## Why this exists (portfolio pitch)

A chatbot answers. An agent *works*. Every AI product company in 2025-26 is moving from the first to the second. This project exists to prove — with shippable code — that the author can architect, build, and defend a production-grade multi-agent system.

Inspired by the multi-agent platform pattern at Helium, rebuilt from scratch with mainstream Node.js + TypeScript.

---

## Demo scenario (what v1 will do)

> *"Hey Workforce, every Monday morning analyze our sales data, write a summary, and flag anything unusual. Also — right now, research our top 3 competitors."*

The system:

1. Schedules the Monday job (recurring, no human touch again).
2. Kicks off the competitor research: the Orchestrator agent says "this is too big for me", splits it 3 ways — Analyst handles one competitor, Researcher handles another, Writer compiles.
3. Saves what it learned into a "brain" so next week it knows more.
4. Streams everything live to a dashboard with charts, documents, and a visual graph showing which agent is doing what.

---

## Core principles

1. **Composition-time safety gates** — read vs. write tool permissions are decided when the agent is *assembled*, not when it runs.
2. **Memory that doesn't blow up** — hierarchical, path-addressed, vector-searchable, LLM-compacted.
3. **Delegation as a first-class primitive** — sync, async, and DAG-orchestration, all depth-capped.
4. **Production resilience out of the box** — idempotency keys, resumable SSE streams, error containment.
5. **One AI surface exposes the same backend the UI uses** — no shadow APIs. Tools call the REST API like everyone else.

---

## Repo layout

```
workforce/
├── apps/
│   ├── cli/            # Phase 1 artifact — terminal agent loop
│   ├── api/            # Phase 2+ — Express backend, BullMQ workers, SSE
│   └── web/            # Phase 5+ — Next.js UI (chat, memory browser, delegation graph)
├── packages/
│   ├── core/           # Capability adapters, prompts, agent registry
│   ├── db/             # Prisma schema, migrations, pgvector setup
│   └── queue/          # BullMQ producers, workers, job definitions
├── docs/
│   ├── architecture.md        # System design deep-dive
│   ├── decisions/             # ADR-001..ADR-008 — written as we build
│   ├── phases/                # Per-phase learnings + validation results
│   ├── learning/              # Curriculum, self-assessments
│   └── interview/             # (Later) prep notes
├── scripts/
│   └── seed.ts                # Seeded demo data (sales, products)
└── docker-compose.yml         # Phase 6
```

---

## Build phases

| Phase | Focus | Artifact | Duration |
|---|---|---|---|
| **0** | Repo scaffolding + dev env | This repo | 1 day |
| **1** | LLM Core (tokens, prompts, tool calling, agent loop) | CLI agent with 1 tool | 1-2 weeks |
| **2** | Streaming, SSE, resumability, idempotency | Chat UI with live stream + refresh-safe resume | 1 week |
| **3** | Embeddings, pgvector, hybrid search, memory tree | Memory CLI + browser | 1-2 weeks |
| **4** | Multi-agent, delegation, plan/action mode, HITL | Orchestrator + 2 workers | 1-2 weeks |
| **5** | BullMQ, task scheduler, recurrence | Scheduled agent runs | 1 week |
| **6** | Docker, deploy, observability | Live URL | 1 week |

See [`ROADMAP.md`](./ROADMAP.md) for the detailed phase-by-phase breakdown.

---

## How learning happens here

Every phase follows the same rhythm:

1. **📋 Topic list** — I list the phase's topics.
2. **🎚️ Self-assessment** — You rate each 🟢 / 🟡 / 🔴 (in the phase's own doc).
3. **📚 Targeted learning** — 🟢 is a refresher, 🟡 is an exercise, 🔴 is a full lesson.
4. **🏗️ Build** — The phase's artifact (CLI tool, UI, memory system, etc.).
5. **✅ Validation** — Mixed format (quizzed, explain-back, or demo + probe). Pass → next phase. Fail → fix, re-validate.

Full curriculum: [`docs/learning/CURRICULUM.md`](./docs/learning/CURRICULUM.md).

---

## Quick start

```bash
# Phase 0 (current) — nothing to run yet
# Phase 1 onwards, see docs/phases/
```

---

## Stack

- **Language**: TypeScript (strict)
- **Runtime**: Node.js 20+
- **Backend**: Express 4 (NOT Fastify — keep it boring)
- **DB**: Postgres 16 + Prisma + pgvector
- **Queue**: BullMQ + Redis
- **LLM**: OpenAI (primary), Anthropic (stretch), Gemini (stretch)
- **AI SDK**: Vercel AI SDK v6
- **UI** (Phase 5+): Next.js 16 + React 19 + Tailwind + React Query
- **Observability**: pino (structured logs), OpenTelemetry (stretch)

---

## Status

- [x] Phase 0 — repo scaffolding
- [ ] Phase 1 — LLM core
- [ ] Phase 2 — Streaming
- [ ] Phase 3 — Memory
- [ ] Phase 4 — Multi-agent
- [ ] Phase 5 — Queues & scheduler
- [ ] Phase 6 — Deploy

Last updated: Phase 0 initialization.
