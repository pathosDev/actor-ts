import { compressorFor } from '../persistence/object-storage/Compression.js';
import { SinkDeliveryError } from './BatchingSink.js';

/**
 * The HTTP half of every sink that ships records to a service.
 *
 * Five sinks POST a body to a URL and have to answer the same question
 * about the response — is this worth trying again? — so the answer lives
 * here rather than five times over.  Getting it wrong in either direction
 * is expensive: retrying a 401 hammers a service that will never accept
 * the request, and *not* retrying a 503 throws away records a restarting
 * collector would have taken a second later.
 *
 * `fetch` is used bare, as everywhere else in the codebase: Bun, Node and
 * Deno all provide it globally.  The `fetchFn` seam exists so a sink's
 * wire format can be asserted byte for byte without a socket.
 */

/** A minimal structural view of `fetch` — the only part a sink uses. */
export type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | string;
  signal?: AbortSignal;
}) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type HttpPostRequest = {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly timeoutMs: number;
  /** gzip the body and set `Content-Encoding`. */
  readonly gzip?: boolean;
  /** Test seam; falls back to the global `fetch`. */
  readonly fetchFn?: FetchLike;
};

/**
 * Statuses worth retrying.
 *
 * This is the OTLP specification's list, and it generalises: 429 is "slow
 * down", and 502/503/504 are a proxy or a backend that is momentarily
 * unavailable.  Everything else — 400 malformed, 401 wrong key, 404 wrong
 * path, 413 too large — describes the *request*, and sending it again
 * unchanged cannot produce a different answer.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * POST a body and translate the outcome into the retry contract.
 *
 * Throws {@link SinkDeliveryError} on a non-2xx; lets a transport failure
 * (a refused connection, a DNS miss) propagate as-is, which `BatchingSink`
 * already treats as retryable — that is exactly what those are.
 */
export async function postToEndpoint(request: HttpPostRequest): Promise<void> {
  const fetchFn = request.fetchFn ?? globalFetch();
  const headers = { ...request.headers };
  let body: Uint8Array | string = request.body;
  if (request.gzip === true) {
    body = await compressorFor('gzip').compress(new TextEncoder().encode(request.body));
    headers['content-encoding'] = 'gzip';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  // Never hold the event loop open for a request nobody is waiting on.
  (timer as unknown as { unref?: () => void }).unref?.();
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(request.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return;

  const detail = await response.text().catch(() => '');
  const summary = `HTTP ${response.status}${detail ? `: ${truncate(detail)}` : ''}`;
  if (!RETRYABLE_STATUS.has(response.status)) {
    throw new SinkDeliveryError(summary, false);
  }
  throw new SinkDeliveryError(summary, true, retryAfterMs(response.headers.get('retry-after')));
}

/**
 * `Retry-After` in milliseconds, or `undefined` when absent or unusable.
 *
 * The header comes in two shapes — delay-seconds and an HTTP date — and
 * honouring it beats the sink's own backoff, because the server knows when
 * it will be ready and the sink is guessing.
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** Basic-auth header value for `user:password`, without a base64 dependency. */
export function basicAuthorization(username: string, password: string): string {
  const raw = `${username}:${password}`;
  // btoa is a Web API present on all three runtimes; it takes latin-1, so
  // encode first to keep a non-ASCII password from throwing.
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function globalFetch(): FetchLike {
  const fetchImpl = (globalThis as { fetch?: unknown }).fetch;
  if (typeof fetchImpl !== 'function') {
    throw new SinkDeliveryError(
      'this log sink needs a global `fetch` (Bun, Node and Deno all provide one); '
      + 'in a bundled environment, make sure `globalThis.fetch` is not stripped',
      false,
    );
  }
  return fetchImpl as FetchLike;
}

function truncate(detail: string): string {
  const collapsed = detail.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}
