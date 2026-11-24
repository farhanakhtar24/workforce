/**
 * Offline tests for the unmounted Better Auth factory (pre-Phase 6):
 * persistence options, trusted origin passthrough, conditional social
 * provider inclusion, and a real Express-v4 mount smoke check against the
 * live Better Auth `/ok` health endpoint. No database: the Prisma client is
 * a bare stub (the adapter binds lazily, nothing is queried), the app
 * listens on an ephemeral port and everything else stays local.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express, { type Express } from 'express';
import type { Server } from 'node:http';

import { createWorkforceAuth, type WorkforceAuth } from '../src/auth/factory.js';
import { AUTH_MOUNT_PATH, AUTH_MOUNT_PATTERN, createAuthExpressHandler } from '../src/auth/express.js';
import { parseAuthEnvironment } from '../src/auth/env-config.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const BASE_URL = 'http://127.0.0.1:3001';
const WEB_ORIGIN = 'http://localhost:3000';

function buildAuth(options: Partial<Parameters<typeof createWorkforceAuth>[0]> = {}): WorkforceAuth {
  return createWorkforceAuth({
    database: {}, // lazy Prisma stub — never queried by these tests
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [WEB_ORIGIN],
    ...options,
  });
}

interface MountedAuth {
  server: Server;
  port: number;
  close(): Promise<void>;
}

async function mountForSmoke(auth: WorkforceAuth): Promise<MountedAuth> {
  const app: Express = express();
  app.all(AUTH_MOUNT_PATTERN, createAuthExpressHandler(auth));
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not get an ephemeral port');
  }
  return {
    server,
    port: address.port,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

test('createWorkforceAuth builds the Express-ready handler contract', () => {
  const auth = buildAuth({ google: { clientId: 'test-google-client-id', clientSecret: 'test-google-secret' } });
  assert.equal(typeof auth.handler, 'function');
  assert.equal(createAuthExpressHandler(auth).length >= 2, true, 'handler must accept (req, res)');
  assert.equal(AUTH_MOUNT_PATH, '/api/auth');
  assert.equal(AUTH_MOUNT_PATTERN, '/api/auth/*');
});

test('createWorkforceAuth persists sessions in the database and trusts only the given web origin', () => {
  const auth = buildAuth();
  assert.equal(auth.options.session?.storeSessionInDatabase, true);
  assert.deepEqual(auth.options.trustedOrigins, [WEB_ORIGIN]);
  assert.equal(auth.options.baseURL, BASE_URL);
  // OAuth-only: no email/password enrollment.
  assert.equal(auth.options.emailAndPassword?.enabled, false);
});

test('createWorkforceAuth includes exactly the providers whose complete pairs it receives', () => {
  const both = buildAuth({
    google: { clientId: 'test-google-client-id', clientSecret: 'test-google-secret' },
    github: { clientId: 'test-github-client-id', clientSecret: 'test-github-secret' },
  });
  assert.deepEqual(Object.keys(both.options.socialProviders ?? {}).sort(), ['github', 'google']);

  const googleOnly = buildAuth({ google: { clientId: 'test-google-client-id', clientSecret: 'test-google-secret' } });
  const googleOnlyProviders = googleOnly.options.socialProviders ?? {};
  assert.equal(googleOnlyProviders.google !== undefined, true);
  assert.equal(googleOnlyProviders.github, undefined);

  const none = buildAuth();
  assert.deepEqual(Object.keys(none.options.socialProviders ?? {}), []);
});

test('env parsing feeds the factory: parseAuthEnvironment + createWorkforceAuth stay consistent', () => {
  const parsed = parseAuthEnvironment({
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: BASE_URL,
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
  });
  const auth = createWorkforceAuth({
    database: {},
    secret: parsed.secret,
    baseURL: parsed.baseURL,
    trustedOrigins: [WEB_ORIGIN],
    google: parsed.google ?? undefined,
    github: parsed.github ?? undefined,
  });
  assert.deepEqual(Object.keys(auth.options.socialProviders ?? {}), ['google']);
  assert.equal(parsed.providerAvailability.github.available, false);
});

test('mounted instance serves Better Auth /ok and an unauthenticated session read', async () => {
  const mounted = await mountForSmoke(buildAuth());
  try {
    const ok = await fetch(`http://127.0.0.1:${mounted.port}/api/auth/ok`);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()) as unknown, { ok: true });

    const session = await fetch(`http://127.0.0.1:${mounted.port}/api/auth/get-session`);
    assert.equal(session.status, 200);
    // Better Auth returns a literal JSON `null` body for a no-cookie session.
    assert.equal((await session.json()) as unknown, null);
  } finally {
    await mounted.close();
  }
});
