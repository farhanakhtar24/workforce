/**
 * Web `Response` → Express `ServerResponse` adapter (ADR-005).
 *
 * AI SDK v6's `createUIMessageStreamResponse` returns a Web `Response`; this
 * server is a separate long-running Express app without Next's `after()`, so
 * the body is piped here with:
 * - exact status/header copy, including `UI_MESSAGE_STREAM_HEADERS`,
 * - streaming with per-chunk flushes: no buffering, no transformation
 *   (no compression middleware is mounted at all),
 * - backpressure via Node's pipe,
 * - client disconnects only stop the pipe; nothing upstream is cancelled, and
 *   the active stream marker is not touched (resume owns that lifecycle).
 */

import { Readable } from 'node:stream';
import type { Response as ExpressResponse } from 'express';

export async function sendWebResponse(webResponse: Response, res: ExpressResponse): Promise<void> {
  res.status(webResponse.status);
  res.statusMessage = webResponse.statusText;
  webResponse.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.flushHeaders();

  const body = webResponse.body;
  if (body === null) {
    res.end();
    return;
  }

  await new Promise<boolean>((resolve) => {
    const nodeStream = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
    nodeStream.on('error', () => {
      // Headers are already sent; the connection drop reports the failure.
      res.destroy();
      resolve(false);
    });
    res.on('close', () => {
      // Client disconnect: stop reading without cancelling anything upstream.
      nodeStream.destroy();
      resolve(false);
    });
    res.on('finish', () => resolve(true));
    nodeStream.pipe(res);
  });
}

/** JSON helper for fixed safe error bodies (never include stacks or provider output). */
export function sendJsonError(res: ExpressResponse, status: number, message: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: message }));
}
