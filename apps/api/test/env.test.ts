/**
 * Env-file hydration (`src/env.ts`): temp files + dummy values ONLY — the
 * loader under test receives explicit temp paths, so real repo env files
 * are never touched and no real key is ever read or written.
 *
 * Serial by default with node:test — keep it that way: `process.env` is
 * process-global and concurrent tests would race. Every test snapshots and
 * restores the exact prior state of every key it touches; dummy keys are
 * prefixed `WORKFORCE_ENV_TEST_` (plus one explicit `OLLAMA_API_KEY`
 * round-trip, also restored) so a real exported value can never leak into
 * or out of these tests. Temp dirs are removed in `finally`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env['WORKFORCE_API_SKIP_LISTEN'] = '1';
const { ENV_FILE_FAILURE_MESSAGE, envFilePaths, loadEnvFiles } = await import('../src/env.js');
const { startupFailureReason } = await import('../src/server.js');

/** Keys these tests touch; never printed, always restored. */
const DUMMY_KEYS = [
  'WORKFORCE_ENV_TEST_A',
  'WORKFORCE_ENV_TEST_B',
  'WORKFORCE_ENV_TEST_C',
  'WORKFORCE_ENV_TEST_D',
  'OLLAMA_API_KEY',
] as const;

/** Restores the exact prior state (value or absence) of the given keys. */
function restoreEnvValues(saved: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Snapshots the dummy keys, runs `run`, restores state, removes temp dirs. */
function withTempEnv(tempDirs: string[], run: () => void): void {
  const saved = new Map<string, string | undefined>(DUMMY_KEYS.map((key) => [key, process.env[key]]));
  try {
    run();
  } finally {
    restoreEnvValues(saved);
    for (const dir of tempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
}

/** One fresh temp dir per test (removed by `withTempEnv`). */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'workforce-env-test-'));
}

/** Writes a dummy env file and returns its path. Dummy values only. */
function writeEnvFile(dir: string, name: string, lines: string[]): string {
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('loader populates process.env from a supplied file path', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    const file = writeEnvFile(dir, '.env', [`WORKFORCE_ENV_TEST_A=from-file-dummy`]);
    loadEnvFiles([file]);
    assert.equal(process.env['WORKFORCE_ENV_TEST_A'], 'from-file-dummy');
  });
});

test('existing nonempty process.env value wins over every env file', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    process.env['WORKFORCE_ENV_TEST_A'] = 'from-shell-dummy';
    const file = writeEnvFile(dir, '.env', [`WORKFORCE_ENV_TEST_A=from-file-dummy`, `WORKFORCE_ENV_TEST_B=only-in-file`]);
    loadEnvFiles([file]);
    // Shell value untouched; the file value still lands for the free key.
    assert.equal(process.env['WORKFORCE_ENV_TEST_A'], 'from-shell-dummy');
    assert.equal(process.env['WORKFORCE_ENV_TEST_B'], 'only-in-file');
  });
});

test('file precedence: app .env.local > root .env.local > app .env > root .env', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    const rootDir = join(dir, 'repo-root');
    const apiDir = join(rootDir, 'apps', 'api');
    const appLocal = writeEnvFile(apiDir, '.env.local', [`WORKFORCE_ENV_TEST_A=app-dot-env-local`]);
    const rootLocal = writeEnvFile(rootDir, '.env.local', [`WORKFORCE_ENV_TEST_A=should-lose`, `WORKFORCE_ENV_TEST_B=root-dot-env-local`]);
    const appEnv = writeEnvFile(apiDir, '.env', [`WORKFORCE_ENV_TEST_B=should-lose`, `WORKFORCE_ENV_TEST_C=app-dot-env`]);
    const rootEnv = writeEnvFile(rootDir, '.env', [`WORKFORCE_ENV_TEST_C=should-lose`, `WORKFORCE_ENV_TEST_D=root-dot-env`]);
    // Highest precedence first — the first loader that sets a key wins.
    loadEnvFiles([appLocal, rootLocal, appEnv, rootEnv]);
    assert.equal(process.env['WORKFORCE_ENV_TEST_A'], 'app-dot-env-local');
    assert.equal(process.env['WORKFORCE_ENV_TEST_B'], 'root-dot-env-local');
    assert.equal(process.env['WORKFORCE_ENV_TEST_C'], 'app-dot-env');
    assert.equal(process.env['WORKFORCE_ENV_TEST_D'], 'root-dot-env');
    // The "should-lose" markers must never have reached process.env.
    for (const value of Object.values(process.env)) {
      if (typeof value === 'string') {
        assert.ok(!value.includes('should-lose'));
      }
    }
  });
});

test('shell-exported value beats every env file, including for OLLAMA_API_KEY', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    process.env['OLLAMA_API_KEY'] = 'exported-dummy-not-a-real-key';
    const appLocal = writeEnvFile(join(dir, 'apps', 'api'), '.env.local', [`WORKFORCE_ENV_TEST_A=x`]);
    const appEnv = writeEnvFile(join(dir, 'apps', 'api'), '.env', ['OLLAMA_API_KEY=file-dummy-not-a-real-key']);
    loadEnvFiles([appLocal, appEnv]);
    assert.equal(process.env['OLLAMA_API_KEY'], 'exported-dummy-not-a-real-key');
  });
});

test('existing empty-string value also wins (Node no-override, documented)', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    process.env['WORKFORCE_ENV_TEST_A'] = '';
    const file = writeEnvFile(dir, '.env', [`WORKFORCE_ENV_TEST_A=from-file-dummy`]);
    loadEnvFiles([file]);
    // Node's process.loadEnvFile keeps ANY existing value, even empty. To
    // let an env file fill a key, the export must be unset in the shell.
    assert.equal(process.env['WORKFORCE_ENV_TEST_A'], '');
  });
});

test('missing files are a no-op and later files still load', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    const missing = join(dir, 'does-not-exist', '.env');
    assert.ok(!existsSync(missing));
    const file = writeEnvFile(dir, '.env', [`WORKFORCE_ENV_TEST_A=from-file-dummy`]);
    loadEnvFiles([missing, file]); // Missing first must not abort the rest.
    assert.equal(process.env['WORKFORCE_ENV_TEST_A'], 'from-file-dummy');
  });
});

test('unreadable file fails startup with the fixed safe reason only', () => {
  // chmod-based denial does not apply when tests run as root.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return;
  }
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    // Hostile-looking dummy content: even if parse were to reach it, nothing
    // from the file may surface. Node's parser is lenient, so unreadable —
    // not syntax — is the failure case (verified for Node 24.20).
    const file = writeEnvFile(dir, '.env', [`WORKFORCE_ENV_TEST_A=dummy-value-with-OLLAMA-KEY http://host/db`]);
    chmodSync(file, 0o000);
    assert.throws(
      () => loadEnvFiles([file]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // EXACT fixed message: no system error code, no path, no content.
        assert.equal(error.message, ENV_FILE_FAILURE_MESSAGE);
        assert.equal(error.message, 'Environment file could not be loaded.');
        assert.ok(!error.message.includes('dummy-value'));
        assert.ok(!error.message.includes(dir));
        return true;
      },
    );
  });
});

test('a directory in place of an env file fails with the same fixed reason', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    const file = join(dir, '.env');
    mkdirSync(file); // existsSync passes; process.loadEnvFile must throw.
    assert.throws(
      () => loadEnvFiles([file]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, ENV_FILE_FAILURE_MESSAGE);
        assert.ok(!error.message.includes(dir));
        return true;
      },
    );
  });
});

test('hydration failure maps to the exact safe startup reason', () => {
  const reason = startupFailureReason(new Error(ENV_FILE_FAILURE_MESSAGE));
  assert.equal(reason, 'Environment file could not be loaded');
  // A hostile message shaped like a parser error never maps here.
  const hostile = startupFailureReason(new Error('WORKFORCE_ENV_TEST path http://user:pass@host failed to parse'));
  assert.notEqual(hostile, 'Environment file could not be loaded');
  assert.ok(!hostile.includes('WORKFORCE_ENV_TEST'));
});

test('envFilePaths returns the exact default order, highest precedence first', () => {
  const dir = makeTempDir();
  withTempEnv([dir], () => {
    const rootDir = join(dir, 'repo-root');
    const apiDir = join(rootDir, 'apps', 'api');
    assert.deepEqual(envFilePaths(rootDir, apiDir), [
      join(apiDir, '.env.local'),
      join(rootDir, '.env.local'),
      join(apiDir, '.env'),
      join(rootDir, '.env'),
    ]);
  });
});
