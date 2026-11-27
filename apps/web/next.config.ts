import type { NextConfig } from 'next';
import { resolveApiInternalOrigin } from './src/lib/api-proxy';

/**
 * Resolve the SERVER-ONLY rewrite target once, at config evaluation (build
 * time for `output: 'standalone'` — resolved rewrites are baked into the
 * routes manifest the standalone runtime serves). A non-origin value fails
 * here with the fixed safe error from the helper — the invalid value itself
 * is never echoed.
 */
const apiInternalOrigin = resolveApiInternalOrigin(process.env.API_INTERNAL_URL);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Phase 6: self-contained production output (apps/web/Dockerfile copies
  // .next/standalone + .next/static). Local `next dev` is unaffected.
  output: 'standalone',
  // Phase 6 single-origin proxy (ADR-009): every browser `/api/*` request —
  // Better Auth mounts, chat POST/GET, SSE resume and scheduler routes — is
  // proxied SERVER-SIDE to the private API origin from `API_INTERNAL_URL`
  // (default `http://localhost:3001`). This is a rewrite, never a client
  // redirect: the browser never sees the internal API host. Development is
  // unchanged: NEXT_PUBLIC_API_URL still points directly at the API and the
  // same-origin browser never exercises this route.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternalOrigin}/api/:path*` }];
  },
};

export default nextConfig;
