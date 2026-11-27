# Production image for @workforce/web (Phase 6, Next.js 15 standalone output).
# Build in one stage (web workspace deps + `next build` with the public
# NEXT_PUBLIC_API_URL build arg — never a secret), then ship the standalone
# server + static assets on a thin Node 24 runtime as the non-root node user.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
# Install only the web workspace (the lockfile stays the source of truth).
RUN npm ci --workspace @workforce/web --no-audit --no-fund

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
# Public browser-facing API origin, inlined into the client bundle at build
# time. Never put any secret here — NEXT_PUBLIC_ variables are public.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# Server-only rewrite target for the single-origin API proxy (ADR-009):
# next.config.ts resolves /api/:path* at BUILD time and bakes the destination
# into the routes manifest the standalone runtime serves. Internal network URL
# only (e.g. http://api.railway.internal:3001); never a secret — the bounded
# http(s)-origin validation in apps/web/src/lib/api-proxy.ts rejects paths,
# queries, hashes and credentials.
ARG API_INTERNAL_URL=http://localhost:3001
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
COPY tsconfig.json ./
COPY apps/web ./apps/web
RUN rm -rf apps/web/.next
RUN npm run build --workspace @workforce/web

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# In a monorepo the standalone output mirrors the workspace layout:
# /app/apps/web/server.js with its pruned node_modules at /app/node_modules.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
