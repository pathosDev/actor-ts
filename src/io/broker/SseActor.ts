import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { SseOptionsValidator } from './SseOptions.js';
import type { SseOptions, SseOptionsType } from './SseOptions.js';

/** Inbound SSE event delivered to subscribers. */
export interface SseEvent {
  /** The `event:` field value, or `'message'` (default per SSE spec). */
  readonly event: string;
  /** The `data:` field value (newline-joined when split across lines). */
  readonly data: string;
  /** Last-event-id, when the server sent one. */
  readonly id?: string;
}

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
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof SseOptionsType> { return ['url', 'target']; }
  protected override optionsValidator(): SseOptionsValidator { return new SseOptionsValidator(); }
  protected endpointLabel(): string { return this.options.url ?? '<unknown>'; }

  protected async connectImplementation(): Promise<void> {
    this.aborter = new AbortController();
    const fetchFn = await fetchLazy.get();
    const res = await fetchFn(this.options.url!, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...(this.options.headers ?? {}) },
      signal: this.aborter.signal,
    });
    if (!res.ok) throw new Error(`SSE connect failed: HTTP ${res.status}`);
    if (!res.body) throw new Error('SSE connect: no response body');

    this.streamRunning = true;
    void this.consume(res.body);
  }

  protected async disconnectImplementation(): Promise<void> {
    this.streamRunning = false;
    try { this.aborter?.abort(); } catch { /* ignore */ }
    this.aborter = null;
  }

  protected async dispatchOutgoing(_env: OutboundEnvelope<never>): Promise<void> {
    throw new Error('SseActor is read-only');
  }

  override onReceive(_cmd: SseCommand): void { /* no commands */ }

  /* ----------------------------- internals ----------------------------- */

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (this.streamRunning) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Cap the pending buffer: a hostile / MITM'd endpoint that streams
        // bytes without an event delimiter (`\n\n`) would otherwise grow it
        // without bound (security audit BRK-2).
        if (buffer.length > SSE_MAX_BUFFER_CHARS) {
          this.streamRunning = false;
          try { this.aborter?.abort(); } catch { /* ignore */ }
          this.handleConnectionLost(
            new Error(`SSE event buffer exceeded ${SSE_MAX_BUFFER_CHARS} chars without a delimiter`),
          );
          return;
        }
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseEventBlock(block);
          if (ev && this.options.target) this.options.target.tell(ev);
          idx = buffer.indexOf('\n\n');
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
  (url: string, opts: { method: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<{
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
