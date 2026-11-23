/**
 * Memory demo seeder for the live Phase 3 UI walkthrough.
 *
 * Run while the REAL API is up, with Farhan's REAL key configured in the
 * SERVER process (`npm run dev`). This script itself NEVER reads an Ollama
 * key and never talks to a model: it only drives the public REST routes via
 * plain HTTP fetches. The one real Ollama call happens server-side — the 31st
 * block crosses the compaction threshold and the API's compactor (glm-5.3-flash,
 * `reasoningEffort: 'low'`, 120s bound) summarizes the 30 oldest blocks; the
 * summary is then embedded by the real local MiniLM worker like any write.
 *
 * Behavior (idempotent — the seeder NEVER appends to existing demo data):
 * - `WORKFORCE_API_URL` — API base (default http://localhost:3001); no secret envs read.
 * - `DEMO_SCOPE` (default `demo`), `DEMO_PATH` (default `compaction/small-models`).
 * - Preflight GET (includeSuperseded=true, limit=100) decides a resume branch:
 *   - ready 30-source summary exists → report success; no writes, no new jobs.
 *   - summary exists but embedding is pending/failed → requeue ONLY its
 *     embedding (POST /blocks/:id/retry once) and poll for ready. Never a
 *     second compaction.
 *   - no summary and all/any blocks pending → poll until ready first, then
 *     queue ONE fresh compaction (POST /api/memory/compact) when >30 active —
 *     this retries a timed-out provider attempt with a fresh trigger and no
 *     new blocks. `failed` blocks exit nonzero with clear guidance.
 *   - ≤30 active without a summary → safe refusal (partial demo set; the
 *     seeder never appends).
 *   - unrecognized block shapes / foreign `learning` content at the path →
 *     safe refusal.
 * - Otherwise (empty path): POST 31 sequential observation blocks (concise,
 *   distinct, domain-neutral small-model latency/quantization/deployment facts).
 * - Bounded poll (overall 180s across ALL stages, 2s interval, 10s per-request
 *   abort) until the summary is ready. Timeout messages point at API logs /
 *   the /memory UI and never imply data loss.
 * - Sources are retained and NEVER cleaned: the demo exists so Farhan can
 *   inspect the summary + 30 superseded sources in the `/memory` UI.
 */
interface MemoryBlock {
  readonly id: unknown;
  readonly scope: unknown;
  readonly path: string;
  readonly kind: string;
  readonly embeddingStatus: string;
  readonly supersededById: string | null;
  readonly metadata: Record<string, unknown>;
}

const BASE_URL = process.env['WORKFORCE_API_URL'] ?? 'http://localhost:3001';
const SCOPE = process.env['DEMO_SCOPE'] ?? 'demo';
const DEMO_PATH = process.env['DEMO_PATH'] ?? 'compaction/small-models';

const REQUEST_TIMEOUT_MS = 10_000;
const POLL_TOTAL_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const PROGRESS_EVERY_SECONDS = 10;
const COMPACT_SOURCES = 30;

/** Thirty-one concise, distinct, domain-neutral facts for the demo path. */
const DEMO_FACTS: readonly string[] = [
  'A 1B-parameter model quantized to 4-bit needs roughly 1GB of RAM and fits on most consumer laptops.',
  '4-bit quantization trades a small accuracy drop for a 3-4x reduction in model size on disk.',
  '8-bit quantization is usually within one or two benchmark points of full precision.',
  'Most small models ship as GGUF files so llama.cpp-style runtimes can mmap them straight from disk.',
  'Memory-mapping a model avoids loading the whole file into RAM before the first token.',
  'Context length dominates KV-cache memory: 8k tokens on a 7B model can exceed 1GB at 16-bit.',
  'Kv-cache quantization, for example to 8-bit, roughly halves cache memory at long context.',
  'Prompt processing on a local GPU is compute-bound; token generation is memory-bandwidth-bound.',
  'Tokens per second for a 3B model on a consumer laptop typically sit in the 10-40 range.',
  'First-token latency of a small local model is dominated by model load time on a cold start.',
  'Keeping the runtime warm removes most cold-start latency between requests.',
  'Batch size 1 is the normal case for local single-user inference, so batching barely helps there.',
  'A 1.5B model on a modern phone CPU reaches about 10 tokens per second with 4-bit weights.',
  'Speculative drafting with a much smaller model can speed up local generation appreciably.',
  'Small draft models miss more rare tokens, which caps the speedup of speculative decoding.',
  'Grouped-query attention cut memory-bandwidth needs and made small models faster on laptops.',
  'Sliding-window attention keeps KV-cache memory flat for long contexts on small models.',
  'Weight-only 4-bit quantization with 16-bit activations is the common local default.',
  'Quantizing to 2-bit usually drops below usable quality for anything beyond retrieval.',
  'CPU offloading lets a model larger than VRAM run, at the cost of per-layer transfer latency.',
  'Splitting layers between GPU and CPU is the standard way to run 13B-class models on 8GB cards.',
  'Mixture-of-experts models activate only part of the network per token, trading RAM for compute.',
  'FlashAttention-style kernels cut redundant memory traffic on supported GPUs for small models too.',
  'Sampling settings do not add latency; every token still costs exactly one forward pass.',
  'Shorter system prompts reduce prefill latency noticeably on CPU-only machines.',
  'Streaming responses let a user start reading while later tokens are still generating.',
  'A load-balanced local inference fleet needs sticky sessions when the runtime caches context.',
  'Dockerized local deployments usually mount the model file as a read-only volume.',
  'ONNX Runtime routes the same small-model graph to CPU, CoreML, or CUDA backends.',
  'OpenAI-compatible local servers let one client codebase hit localhost like a hosted endpoint.',
  'Latency budgets for local agents are set per step, not per request, because tools loop.',
];

interface FetchOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly bodyText: string;
}

/** Bounded fetch: fixed text errors, never raw env values, never hanging. */
async function request(method: string, pathname: string, body?: unknown): Promise<FetchOutcome> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const bodyText = await response.text();
  return { ok: response.ok, status: response.status, bodyText };
}

function fail(message: string): never {
  console.error(`memory demo failed: ${message}`);
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the block is the demo's compaction summary (30 compactedFromIds). */
function isDemoSummary(block: MemoryBlock): boolean {
  return (
    block.kind === 'learning' &&
    Array.isArray(block.metadata['compactedFromIds']) &&
    (block.metadata['compactedFromIds'] as unknown[]).length === COMPACT_SOURCES
  );
}

/** Lists blocks at the exact demo scope/path (prefix-included by the API). */
async function listBlocks(): Promise<readonly MemoryBlock[]> {
  const query =
    `?scope=${encodeURIComponent(SCOPE)}` +
    `&path=${encodeURIComponent(DEMO_PATH)}` +
    `&includeSuperseded=true&limit=100`;
  let outcome: FetchOutcome;
  try {
    outcome = await request('GET', `/api/memory/blocks${query}`);
  } catch (error) {
    fail(
      `could not reach the API (HTTP request failed or timed out); is the dev API running with WORKFORCE_API_URL set correctly? (${error instanceof Error ? error.name : 'unknown'})`,
    );
  }
  if (!outcome.ok) {
    fail(`preflight GET returned HTTP ${String(outcome.status)}: ${outcome.bodyText.slice(0, 120)}`);
  }
  try {
    const parsed = JSON.parse(outcome.bodyText) as { blocks?: unknown };
    if (!Array.isArray(parsed.blocks)) {
      fail('preflight GET returned an unexpected body shape');
    }
    for (const block of parsed.blocks as unknown[]) {
      const candidate = block as MemoryBlock;
      const shapeOk =
        block !== null && typeof block === 'object' &&
        typeof candidate.id === 'string' && candidate.id.length > 0 &&
        (candidate.scope === SCOPE || candidate.scope === 'default') &&
        typeof candidate.path === 'string' &&
        typeof candidate.kind === 'string' &&
        (candidate.embeddingStatus === 'pending' || candidate.embeddingStatus === 'ready' || candidate.embeddingStatus === 'failed') &&
        (candidate.supersededById === null || typeof candidate.supersededById === 'string') &&
        candidate.metadata !== null && typeof candidate.metadata === 'object';
      if (!shapeOk) {
        fail('unrecognized block shape at the demo path — refusing to touch existing data');
      }
    }
    return parsed.blocks as readonly MemoryBlock[];
  } catch (error) {
    fail('preflight GET returned malformed JSON');
  }
}

/** Validates the existing data and classifies it for the resume branches. */
function analyze(
  blocks: readonly MemoryBlock[],
): { summary: MemoryBlock | undefined; activeCount: number; pendingCount: number; failedCount: number } {
  let summary: MemoryBlock | undefined;
  let activeCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  for (const block of blocks) {
    if (block.kind === 'learning') {
      if (isDemoSummary(block)) {
        if (summary !== undefined) {
          fail(
            `more than one compaction summary exists at scope=${SCOPE} path=${DEMO_PATH} — refusing to touch existing data`,
          );
        }
        summary = block;
        continue;
      }
      // A learning block that is NOT this demo's summary could be user data;
      // never implicitly compact content this seeder did not create.
      fail(
        `scope=${SCOPE} path=${DEMO_PATH} holds non-demo learning content; ` +
          'choose a new DEMO_PATH (existing data is left untouched)',
      );
    }
    if (block.supersededById === null) {
      activeCount += 1;
    }
    if (block.embeddingStatus === 'pending') {
      pendingCount += 1;
    }
    if (block.embeddingStatus === 'failed') {
      failedCount += 1;
    }
  }
  return { summary, activeCount, pendingCount, failedCount };
}

function reportSuccess(summary: MemoryBlock): void {
  console.log(
    `compaction ready: scope=${SCOPE} path=${DEMO_PATH} ` +
      `summaryId=${String(summary.id)} status=ready compactedSources=${String(COMPACT_SOURCES)}`,
  );
  console.log(
    'Open /memory, browse that scope/path with "include superseded" on:',
    'the summary plus its 30 retained sources are left in place on purpose.',
  );
}

/**
 * Bounded poll for the demo summary (30 compactedFromIds) reaching `ready`.
 * Timeout messages point at API logs + UI and never imply data loss — the
 * whole flow is resumable by rerunning the seeder.
 */
async function pollForReadySummary(deadline: number): Promise<void> {
  let lastSeenSummaryId: string | null = null;
  let lastSeenStatus: string | null = null;
  for (;;) {
    if (Date.now() >= deadline) {
      if (lastSeenSummaryId === null) {
        fail(
          `no compaction summary appeared within budget at scope=${SCOPE} path=${DEMO_PATH} — ` +
            'the provider compaction may still be retrying (a BullMQ attempt can take up to 120s each). ' +
            'Inspect the API logs / queue output and the /memory UI, then rerun `npm run demo:memory` later — no data loss.',
        );
      }
      fail(
        `summary ${lastSeenSummaryId} found but not ready at scope=${SCOPE} path=${DEMO_PATH} (last status: ${String(lastSeenStatus)}) — ` +
          'the embedding worker may still be processing it. Inspect the API logs / the /memory UI, then rerun `npm run demo:memory` later — no data loss.',
      );
    }
    const blocks = await listBlocks();
    const summary = blocks.find(isDemoSummary);
    if (summary !== undefined) {
      if (summary.id !== lastSeenSummaryId || summary.embeddingStatus !== lastSeenStatus) {
        lastSeenSummaryId = String(summary.id);
        lastSeenStatus = summary.embeddingStatus;
        console.log(`summary ${lastSeenSummaryId}; embeddingStatus=${lastSeenStatus}`);
      }
      if (summary.embeddingStatus === 'ready') {
        reportSuccess(summary);
        return;
      }
      if (summary.embeddingStatus === 'failed') {
        fail(
          `summary ${String(summary.id)} embedding failed at scope=${SCOPE} path=${DEMO_PATH} — ` +
            'retry it via the /memory UI (or POST /api/memory/blocks/:id/retry), then rerun `npm run demo:memory`',
        );
      }
    } else if (Date.now() % (PROGRESS_EVERY_SECONDS * 1000) < POLL_INTERVAL_MS) {
      console.log(`still waiting for the compaction summary (polling scope=${SCOPE} path=${DEMO_PATH})…`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Waits (bounded) until no demo block is pending/failed, then returns. */
async function pollUntilBlocksReady(deadline: number, analysis: { pendingCount: number; failedCount: number }): Promise<void> {
  for (;;) {
    if (Date.now() >= deadline) {
      fail(
        `blocks still not ready within budget at scope=${SCOPE} path=${DEMO_PATH} ` +
          `(${String(analysis.pendingCount)} pending, ${String(analysis.failedCount)} failed) — ` +
          'inspect the API logs / the /memory UI, retry failed blocks there, then rerun `npm run demo:memory` — no data loss.',
      );
    }
    const blocks = await listBlocks();
    const fresh = analyze(blocks);
    if (fresh.failedCount > 0) {
      fail(
        `${String(fresh.failedCount)} block(s) failed to embed at scope=${SCOPE} path=${DEMO_PATH} — ` +
          'retry them via the /memory UI (or POST /api/memory/blocks/:id/retry), then rerun `npm run demo:memory`',
      );
    }
    if (fresh.pendingCount === 0) {
      return;
    }
    console.log(`waiting for ${String(fresh.pendingCount)} block(s) to finish embedding…`);
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Requeues ONLY the summary's embedding job (never a second compaction). */
async function requeueSummaryEmbedding(summaryId: string): Promise<void> {
  let outcome: FetchOutcome;
  try {
    outcome = await request('POST', `/api/memory/blocks/${encodeURIComponent(summaryId)}/retry`);
  } catch (error) {
    fail(`summary embedding requeue request failed or timed out (${error instanceof Error ? error.name : 'unknown'})`);
  }
  if (!outcome.ok || outcome.status !== 202) {
    fail(
      `summary embedding requeue returned HTTP ${String(outcome.status)}: ${outcome.bodyText.slice(0, 120)} — ` +
        'inspect the API logs / the /memory UI, then rerun `npm run demo:memory` later',
    );
  }
  console.log(`requeued summary ${summaryId} embedding (HTTP 202); waiting for it to become ready…`);
}

/** Queues ONE fresh compaction with a new trigger (retry without new blocks). */
async function queueFreshCompaction(): Promise<void> {
  let outcome: FetchOutcome;
  try {
    outcome = await request('POST', '/api/memory/compact', { scope: SCOPE, path: DEMO_PATH });
  } catch (error) {
    fail(`compaction queue request failed or timed out (${error instanceof Error ? error.name : 'unknown'})`);
  }
  if (!outcome.ok || outcome.status !== 202) {
    fail(
      `POST /api/memory/compact returned HTTP ${String(outcome.status)}: ${outcome.bodyText.slice(0, 120)} — ` +
        'inspect the API logs, then rerun `npm run demo:memory` later',
    );
  }
  let triggerBlockId = 'unknown';
  try {
    const parsed = JSON.parse(outcome.bodyText) as { status?: unknown; triggerBlockId?: unknown };
    if (parsed.status !== 'queued' || typeof parsed.triggerBlockId !== 'string') {
      fail('compaction queue returned an unexpected body shape');
    }
    triggerBlockId = parsed.triggerBlockId;
  } catch (error) {
    fail('compaction queue returned malformed JSON');
  }
  console.log(`fresh compaction queued (HTTP 202, trigger ${triggerBlockId}); waiting for the summary…`);
}

async function main(): Promise<void> {
  console.log(`memory demo target: scope=${SCOPE} path=${DEMO_PATH}`);
  // One overall budget shared by every stage (first-run seed is exempt: it is
  // 31 fast write calls; all polling/resume stages share the deadline).
  const deadline = Date.now() + POLL_TOTAL_MS;

  const existing = await listBlocks();

  // -- Empty path: the original first-run behavior -----------------------------
  if (existing.length === 0) {
    for (let i = 0; i < DEMO_FACTS.length; i += 1) {
      const content = DEMO_FACTS[i];
      if (content === undefined) {
        fail('demo fact list was shorter than expected (script bug)');
      }
      let outcome: FetchOutcome;
      try {
        outcome = await request('POST', '/api/memory/blocks', {
          scope: SCOPE,
          path: DEMO_PATH,
          kind: 'observation',
          content,
        });
      } catch (error) {
        fail(`block ${String(i + 1)} write request failed or timed out (${error instanceof Error ? error.name : 'unknown'})`);
      }
      if (!outcome.ok || outcome.status !== 201) {
        fail(`block ${String(i + 1)} write returned HTTP ${String(outcome.status)}: ${outcome.bodyText.slice(0, 120)}`);
      }
    }
    console.log(`seeded ${String(DEMO_FACTS.length)} observations; waiting for server-side compaction…`);
    await pollForReadySummary(deadline);
    return;
  }

  // -- Existing path: resume branches (never append, never duplicate) ----------
  const analysis = analyze(existing);
  console.log(
    `scope=${SCOPE} path=${DEMO_PATH} already holds ${String(existing.length)} block(s) ` +
      `(${String(analysis.activeCount)} active; blocks: embeddingStatus pending/failed counts ` +
      `${String(analysis.pendingCount)}/${String(analysis.failedCount)})`,
  );

  if (analysis.summary !== undefined) {
    const summary = analysis.summary;
    if (summary.embeddingStatus === 'ready') {
      reportSuccess(summary);
      return;
    }
    // pending/failed: requeue ONLY the embedding and poll. Never a second compaction.
    await requeueSummaryEmbedding(String(summary.id));
    await pollForReadySummary(deadline);
    return;
  }

  // No summary yet.
  if (analysis.failedCount > 0) {
    fail(
      `${String(analysis.failedCount)} source block(s) failed to embed at scope=${SCOPE} path=${DEMO_PATH} — ` +
        'retry them via the /memory UI (or POST /api/memory/blocks/:id/retry), then rerun `npm run demo:memory`',
    );
  }
  if (analysis.pendingCount > 0) {
    // Embedding still in flight: wait (bounded) BEFORE queueing compaction.
    await pollUntilBlocksReady(deadline, analysis);
  }
  if (analysis.activeCount > COMPACT_SOURCES) {
    // Exact resumed state (31 ready, no summary): retry compaction with a
    // fresh trigger — no new blocks, exactly one queued compaction.
    await queueFreshCompaction();
    await pollForReadySummary(deadline);
    return;
  }
  console.log(
    `scope=${SCOPE} path=${DEMO_PATH} holds ${String(analysis.activeCount)} active block(s) without a summary — ` +
      'too few for compaction, and this seeder never appends to a partial demo set. ' +
      'Choose a new DEMO_PATH to start a clean run (existing data is left untouched).',
  );
}

void main().catch((error: unknown) => {
  console.error(`memory demo failed: unexpected error (${error instanceof Error ? error.name : typeof error})`);
  process.exit(1);
});
