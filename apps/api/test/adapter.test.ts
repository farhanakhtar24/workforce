/**
 * The Web-Response → Express adapter (ADR-005): exact header/status copy,
 * streaming without buffering (two chunks stay two writes), correct flush, and
 * an empty-body 204 path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import type { Response as ExpressResponse } from 'express';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { sendWebResponse } from '../src/http/adapter.js';

class MockExpressResponse extends Writable {
  readonly written: Buffer[] = [];
  readonly headers = new Map<string, string>();
  private assignedStatus = 0;
  statusTextValue = '';
  flushed = false;
  ended = false;

  constructor() {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(chunk);
    callback();
  }

  override end(chunk?: unknown): this {
    if (chunk !== undefined) {
      this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    this.ended = true;
    this.emit('finish');
    return this;
  }

  status(code: number): this {
    this.assignedStatus = code;
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  flushHeaders(): void {
    this.flushed = true;
  }

  get statusCodeValue(): number {
    return this.assignedStatus;
  }

  text(): string {
    return Buffer.concat(this.written).toString('utf8');
  }
}

function asExpressResponse(mock: MockExpressResponse): ExpressResponse {
  return mock as unknown as ExpressResponse;
}

function delayedResponse(chunks: string[], delayMs = 10): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { ...UI_MESSAGE_STREAM_HEADERS, 'x-test': 'yes' } },
  );
}

test('adapter copies status and the UI message stream headers exactly', async () => {
  const res = new MockExpressResponse();
  const response = delayedResponse(['one']);
  await sendWebResponse(response, asExpressResponse(res));
  assert.equal(res.statusCodeValue, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  assert.equal(res.headers.get('x-test'), 'yes');
  assert.equal(res.flushed, true, 'headers must flush before the first body chunk');
  assert.equal(res.text(), 'one');
  assert.equal(res.ended, true);
});

test('adapter streams without buffering: delayed chunks arrive as separate writes', async () => {
  const res = new MockExpressResponse();
  let afterFirst = 0;
  const original = sendWebResponse;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('chunk-1\n'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.enqueue(encoder.encode('chunk-2\n'));
        controller.close();
      },
    }),
    { headers: UI_MESSAGE_STREAM_HEADERS },
  );
  const promise = original(response, asExpressResponse(res));
  // Sample the write count while the second chunk is still in flight.
  setTimeout(() => {
    afterFirst = res.written.length;
  }, 15);
  await promise;
  assert.ok(afterFirst >= 1, 'first chunk must be written before the second arrives');
  assert.ok(afterFirst < 2, `no early buffering of both chunks (saw ${afterFirst})`);
  assert.equal(res.text(), 'chunk-1\nchunk-2\n');
});

test('adapter handles null bodies (204 path) and empty data', async () => {
  const res = new MockExpressResponse();
  await sendWebResponse(new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }), asExpressResponse(res));
  assert.equal(res.statusCodeValue, 204);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.text(), '');
  assert.equal(res.ended, true);
});

test('adapter destroys the connection when the source stream fails', async () => {
  const res = new MockExpressResponse();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('first'));
        setTimeout(() => controller.error(new Error('upstream exploded')), 5);
      },
    }),
    { headers: UI_MESSAGE_STREAM_HEADERS },
  );
  // Must settle quickly (not hang), leaving the connection torn down.
  await Promise.race([
    sendWebResponse(response, asExpressResponse(res)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('adapter hung on stream failure')), 2_000)),
  ]);
  assert.equal(res.destroyed, true, 'failed stream must destroy the HTTP connection');
  assert.equal(res.text(), 'first');
});
