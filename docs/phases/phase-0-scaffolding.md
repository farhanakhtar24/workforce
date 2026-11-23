# Phase 0 — Scaffolding

**Duration**: 1 day
**Goal**: A clean, working repo skeleton. No code, no learning. Just scaffolding so every later phase has a home.

---

## What gets built in this phase

- All folders from [`README.md`](../../README.md#repo-layout) created
- Workspace root `package.json` with npm workspaces configured (`apps/*`, `packages/*`)
- Root `tsconfig.json` (`strict: true`)
- Root `.gitignore`, `.nvmrc`, `.editorconfig`
- Doc skeletons: `docs/architecture.md`, `docs/decisions/`, `docs/phases/`, `docs/learning/`
- This file plus stubs for Phases 1-6
- First commit on `main` branch

**Explicitly NOT built in this phase:**
- No Express server
- No chat UI
- No DB setup
- No Redis setup

Those start in Phase 1.

---

## Topics to self-assess

Rate yourself **🟢 / 🟡 / 🔴** next to each. This phase is mostly review — you're expected to be 🟢 on most of these. If you're 🟡 or 🔴 on any, spend 30-60 minutes refreshing before moving on.

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 0.1 | TypeScript strict mode (generics, unions, `satisfies`) | _ | |
| 0.2 | Node.js async model (event loop, streams) | _ | |
| 0.3 | REST API design + middleware (Express) | _ | |
| 0.4 | Git basics (commit, branch, PR) | _ | |
| 0.5 | SQL fundamentals (joins, GROUP BY, indexes) | _ | |
| 0.6 | npm workspaces | _ | |
| 0.7 | Zod (basic schemas, safe parsing) | _ | |

> To fill in: replace `_` with 🟢 / 🟡 / 🔴. Add a note for 🟡 and 🔴 explaining what's rusty or missing.

---

## What you should be able to answer when this phase ends

- Why npm workspaces (not pnpm/turborepo) for v1? *(hint: fewer moving parts, mainstream familiarity)*
- Why Express (not Fastify, not Hono)? *(hint: boring, well-known, interviewers recognize it)*
- What does `strict: true` do in `tsconfig.json`?
- Why do we keep `apps/` and `packages/` separate? *(hint: runtime vs. library code)*

---

## Scaffold checklist (tick when done)

- [x] Folder structure in place
- [x] Root `package.json` (workspaces: `apps/*`, `packages/*`)
- [x] Root `tsconfig.json` with `strict: true`
- [x] `.gitignore` (node_modules, .env, dist, .next)
- [x] `.nvmrc` → `24` (migrated from `20` on 2026-11-21, Node 24)
- [x] `.editorconfig`
- [x] `docs/` skeleton complete
- [x] Git init + first commit
- [ ] Self-assessment ratings filled in above
- [ ] Q&A: can answer the 4 "what you should be able to answer" questions

---

## Validation gate for Phase 0

This phase has no quiz. **Validation = I (or you) run:**

```bash
cd /Users/mohdfarhanakhtar/Code/projects/workforce
ls -la
ls apps/
ls packages/
ls docs/
cat package.json
```

If all folders exist and `package.json` parses, Phase 0 is ✅.

---

## Next

→ Start [Phase 1 — LLM Core](./phase-1-llm-core.md)
