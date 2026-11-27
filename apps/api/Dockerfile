# Production image for @workforce/api (Phase 6). Bookworm-slim (not alpine)
# for native-addon compatibility (pg, onnxruntime-node/@huggingface/tokenizers,
# Prisma engines). Multi-stage: full dev install + builds (core → queue → api),
# then a production-deps-only runtime. The `migrate` target is a one-shot
# `prisma migrate deploy` release step; the scheduler service reuses THIS SAME
# runtime image with a different command (node apps/api/dist/scheduler-worker.js).
# No secrets are baked in: every credential arrives via compose `environment`
# at runtime.

# Build deps: full npm ci from the ROOT lockfile (single lock, workspaces).
# Workspace package.json files are copied first for a stable install layer.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
# The lockfile references every workspace, including apps/cli and packages/db,
# so workspace package.json files must be present (even unused ones) for a
# deterministic `npm ci`. Root tsconfig is loaded later by the build stage.
RUN npm ci --no-audit --no-fund

# Build stage: sources + deterministic builds in the required order
# core → queue → API (CLI is never built or shipped in images).
# core build already runs `prisma generate` (wrapper script) and emits the
# generated client into packages/core/generated/prisma together with the
# query engine binary for the build platform.
FROM deps AS build
COPY tsconfig.json ./
COPY packages/core ./packages/core
COPY packages/queue ./packages/queue
COPY apps/api ./apps/api
# Clear anything host-side that leaked past .dockerignore; builds must be
# reproducible from source only.
RUN rm -rf packages/core/dist packages/core/generated packages/queue/dist apps/api/dist
RUN npm run build --workspace @workforce/core
RUN npm run build --workspace @workforce/queue
RUN npm run build --workspace @workforce/api

# Production dependencies: same root lockfile, dev deps omitted.
FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
RUN npm ci --omit=dev --no-audit --no-fund

# Runtime: production node_modules + built workspaces only, run as node (1000).
# npm keeps some packages workspace-local (e.g. better-auth is NOT hoisted to
# the root node_modules), so the whole prod-deps workspace tree (package.json
# files + any workspace-local node_modules) travels; built dist/output from
# the build stage overlays it.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=prod-deps --chown=node:node /app/apps ./apps
COPY --from=prod-deps --chown=node:node /app/packages ./packages
# API runtime needs no web/CLI workspace payload (their deps stay in the web
# image; @workforce/queue+core come from the build stage overlays below).
RUN rm -rf /app/apps/web /app/apps/cli
# Built TypeScript output + generated Prisma client (incl. query engine).
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/core/generated ./packages/core/generated
COPY --from=build --chown=node:node /app/packages/queue/dist ./packages/queue/dist
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
# Pre-create the Transformers.js model cache with node ownership so the named
# volume mounted there inherits correct ownership on first use.
RUN mkdir -p /app/.cache/workforce-models && chown -R node:node /app/.cache
USER node
EXPOSE 3001
# API server. The scheduler service runs the same image with
# `command: node apps/api/dist/scheduler-worker.js` (see docker-compose.yml).
CMD ["node", "apps/api/dist/server.js"]

# One-shot migration release step: `prisma migrate deploy` via the existing
# wrapper (packages/core/scripts/prisma-migrate.mjs), which requires the full
# dev install (Prisma CLI) + schema + SQL migrations. DATABASE_URL comes from
# the service environment; the wrapper never starts containers.
FROM deps AS migrate
COPY packages/core/scripts ./packages/core/scripts
COPY packages/core/prisma ./packages/core/prisma
USER node
CMD ["node", "packages/core/scripts/prisma-migrate.mjs"]
