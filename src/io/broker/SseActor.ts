import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { SseEventBuffer } from './SseEventBuffer.js';
import { SseOptionsValidator } from './SseOptions.js';
import type { SseOptions, SseOptionsType } from './SseOptions.js';

/** Inbound SSE event delivered to subscribers. */
export type SseEvent = {
  /** The `event:` field value, or `'message'` (default per SSE spec). */
  readonly event: string;
  /** The `data:` field value (newline-joined when split across lines). */
  readonly data: string;
  /** Last-event-id, when the server sent one. */
  readonly id?: string;
};

export type SseCommand = never;  // SSE is read-only

/**
 * Safety cap on the pending event buffer (chars).  A well-behaved server
 * delimits events with `\n\n` frequently; this bounds the damage from one
 * that never does (security audit BRK-2).  1 MiB is far above any real
 * single SSE event.
 */
const SSE_MAX_BUFFER_CHARS = 1_048_576;

/**
 * Server-Sent Events client actor.  Pure built-ins — uses `fetch`
 * (Bun + Node 18+ + Deno all have it) and parses the wire format
 * inline.  No outbound — SSE is unidirectional from server.
 *
 * The base class' reconnect machinery applies on stream close.
 */
export class SseActor extends BrokerActor<SseOptionsType, SseCommand, never> {
  private aborter: AbortController | null = null;
  private streamRunning = false;

  constructor(options: SseOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.sse; }
  protected builtInDefaultOptions(): Partial<SseOptionsType> { return {}; }
  protected readOptionsFromConfig(config: Config): Partial<SseOptionsType> {
    const out: { -readonly [K in keyof SseOptionsType]?: SseOptionsType[K] } = {};
    if (config.hasPath('url')) out.url = config.getString('url');
    if (config.hasPath('headers')) {
      const headers: Record<string, string> = {};
      for (const [headerName, headerValue] of Object.entries(config.getObject('headers'))) {
        if (typeof headerValue === 'string') headers[headerName] = headerValue;
      }
      out.headers = headers;
    }
    if (config.hasPath('idleTimeoutMs')) out.idleTimeoutMs = config.getDuration('idleTimeoutMs');
    if (config.hasPath('connectTimeoutMs')) out.connectTimeoutMs = config.getDuration('connectTimeoutMs');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof SseOptionsType> { return ['url', 'target']; }
  protected override optionsValidator(): SseOptionsValidator { return new SseOptionsValidator(); }
  protected endpointLabel(): string { return this.options.url ?? '<unknown>'; }

  protected override idleTimeoutMs(): number | undefined { return this.options.idleTimeoutMs; }
  protected override connectTimeoutMs(): number | undefined { return this.options.connectTimeoutMs; }

  /**
   * Abandon the stream the same way a breached buffer cap does — the abort is
   * what unparks `consume`'s `await reader.read()`, which otherwise waits on a
   * server that will never speak again.  `streamRunning` goes first so the
   * unparked loop reports nothing on its way out; this call owns the report.
   */
  protected override handleIdleTimeout(cause: Error): void {
    this.streamRunning = false;
    try { this.aborter?.abort(); } catch { /* ignore */ }
    this.handleConnectionLost(cause);
  }

  /**
   * Fail the in-flight `fetch` the base class has given up on.
   *
   * The abort signal is already threaded through the request, so this needs
   * no second mechanism: aborting rejects the `await fetch(...)` inside
   * `connectImplementation`, and the base class's catch does the rest.  The
   * cause is dropped deliberately — `fetch` raises its own `AbortError`, and
   * the message the deadline built cannot be attached to it without wrapping
   * a promise this method does not hold.
   */
  protected override abortConnectAttempt(_cause: Error): void {
    try { this.aborter?.abort(); } catch { /* ignore */ }
  }

  protected async connectImplementation(): Promise<void> {
    this.aborter = new AbortController();
    const fetchFunction = await fetchLazy.get();
    const response = await fetchFunction(this.options.url!, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...(this.options.headers ?? {}) },
      signal: this.aborter.signal,
    });
    if (!response.ok) throw new Error(`SSE connect failed: HTTP ${response.status}`);
    if (!response.body) throw new Error('SSE connect: no response body');

    this.streamRunning = true;
    void this.consume(response.body);
  }

  protected async disconnectImplementation(): Promise<void> {
    this.streamRunning = false;
    try { this.aborter?.abort(); } catch { /* ignore */ }
    this.aborter = null;
  }

  protected async dispatchOutgoing(_env: OutboundEnvelope<never>): Promise<void> {
    throw new Error('SseActor is read-only');
  }

  protected override onCommand(_command: SseCommand): void { /* no commands */ }

  /* ----------------------------- internals ----------------------------- */

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    const buffer = new SseEventBuffer();
    try {
      while (this.streamRunning) {
        const { done, value } = await reader.read();
        if (done) break;
        // Any chunk counts, including a `: keepalive` comment that parses to
        // no event at all — which is exactly how a well-behaved server holds
        // an idle feed open (#753).
        this.noteInboundActivity();
        const text = decoder.decode(value, { stream: true });
        // Cap the pending buffer: a hostile / MITM'd endpoint that streams
        // bytes without an event delimiter (`\n\n`) would otherwise grow it
        // without bound (security audit BRK-2).  Measured on what the chunk
        // *would* make pending, before any of it is split off, so the bound is
        // the one the cap has always enforced.  What it does not bound is the
        // work spent reaching it — that is `SseEventBuffer`'s job (#749).
        if (buffer.pendingLength() + text.length > SSE_MAX_BUFFER_CHARS) {
          this.streamRunning = false;
          try { this.aborter?.abort(); } catch { /* ignore */ }
          this.handleConnectionLost(
            new Error(`SSE event buffer exceeded ${SSE_MAX_BUFFER_CHARS} chars without a delimiter`),
          );
          return;
        }
        for (const block of buffer.push(text)) {
          const event = parseEventBlock(block);
          if (event && this.options.target) this.options.target.tell(event);
        }
      }
    } catch (e) {
      if (this.streamRunning) {
        this.handleConnectionLost(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      if (this.streamRunning) {
        this.handleConnectionLost(new Error('SSE stream ended'));
      }
    }
  }
}

/* --------------------- inline SSE wire-format parser ------------------- */

function parseEventBlock(block: string): SseEvent | null {
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    if (!raw || raw.startsWith(':')) continue;
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let val = colon < 0 ? '' : raw.slice(colon + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') dataLines.push(val);
    else if (field === 'id') id = val;
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n'), id };
}

interface FetchModule {
  (url: string, options: { method: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    body: ReadableStream<Uint8Array> | null;
  }>;
}

const fetchLazy: Lazy<Promise<FetchModule>> = Lazy.of(async () => {
  const fetchImpl = (globalThis as { fetch?: FetchModule }).fetch;
  if (typeof fetchImpl === 'function') return fetchImpl;
  throw new Error(
    'SseActor needs a global `fetch` (Bun, Node, and Deno all provide one).  '
    + 'In bundled/edge environments, ensure `globalThis.fetch` is not stripped.',
  );
});
