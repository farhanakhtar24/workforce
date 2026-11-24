# Phase 6 — Docker, Deploy, Observability

**Duration**: 1 week
**Goal**: Live URL. Not localhost.

> Status (2026-11-24): **Paused — NOT started.** Farhan explicitly paused this phase in favor of the pre-Phase-6 product feature sprint (auth + per-user workspaces + chat/model/usage/learning features), planned in [`design-plans/pre-phase-6-product-features.md`](../../design-plans/pre-phase-6-product-features.md). Phase 5 was validated 2026-11-24; this phase may begin only after that sprint closes with its own recorded gate. Nothing in the sprint counts as Phase 6 progress.

---

## What gets built in this phase

- `docker-compose.yml` that brings up `api + postgres + redis + web` with one command
- Structured logging via `pino` (JSON logs, correlation IDs)
- (Stretch) OpenTelemetry tracing on the agent loop
- Deployment to Railway / Render / Fly.io with managed Postgres (Neon) + Redis (Upstash)
- Public URL where anyone can chat with an agent and schedule a task

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 6.1 | Docker Compose (services, volumes, networks) | _ | |
| 6.2 | Structured logging (pino, JSON logs, correlation IDs) | _ | |
| 6.3 | OpenTelemetry concepts (spans, traces) | _ | |
| 6.4 | Deployment targets (Railway / Render / Fly / Neon / Upstash) | _ | |
| 6.5 | 12-factor app principles (env config, secrets) | _ | |

---

## Build artifact spec

*To be detailed at phase kickoff.*

---

## Validation gate for Phase 6

I click the public URL. I chat with an agent. I schedule a task. It runs. If any of those three things fail, we fix until they don't.

---

## Final deliverables

- ✅ Live URL
- ✅ 3-minute demo video (recorded)
- ✅ 8 ADRs complete
- ✅ Clean README with architecture diagram
- ✅ Talking points doc (for interviews)

---

## After Phase 6

You'll have a portfolio-grade multi-agent platform, and the story to defend it in any system-design interview.

→ Extract interview talking points into `docs/interview/talking-points.md` (separate session).
