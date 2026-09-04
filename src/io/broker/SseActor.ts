import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { redactUrlCredentials } from '../../util/RedactUrlCredentials.js';
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
      redirect: 'manual',
      signal: this.aborter.signal,
    });
    try {
      // Before `ok`, deliberately: `redirect: 'manual'` surfaces the 3xx
      // itself, and "HTTP 302" alone would tell an operator nothing about the
      // policy that produced it.
      this.refuseRedirect(response);
      if (!response.ok) throw new Error(`SSE connect failed: HTTP ${response.status}`);
      this.requireEventStreamContentType(response);
      if (!response.body) throw new Error('SSE connect: no response body');
    } catch (rejection) {
      // A refused response still has an open body nothing will ever read, and
      // the failure path does not run `disconnectImplementation` — so the
      // socket to the endpoint that just failed the check would stay up until
      // the garbage collector got to it.  Aborting the signal releases it.
      try { this.aborter?.abort(); } catch { /* ignore */ }
      throw rejection;
    }

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

  /**
   * Refuse a redirect rather than follow it (#787).
   *
   * `fetch` defaults to `redirect: 'follow'`, and the Fetch standard strips
   * only `Authorization`, `Cookie` and `Proxy-Authorization` when a redirect
   * crosses origins.  Every other operator-supplied header survives — which
   * for the feeds this actor exists to consume means the `x-api-key` shape
   * most LLM and market-data vendors require, replayed verbatim to whatever
   * host the feed names.  Following also makes a long-lived outbound client a
   * blind-SSRF primitive: the endpoint, not the configuration, picks the
   * address the authenticated `GET` actually reaches — link-local addresses
   * included — and whatever comes back is parsed and fanned into `target`.
   *
   * Refusing outright is the whole policy, and that is a choice.  Re-issuing
   * the request to a same-origin target would need a strip-list of credential
   * header names that rots as vendors invent new ones, and it would buy an
   * operator nothing they cannot get by configuring the final URL: an endpoint
   * that has moved now fails the connect and degrades through the base class'
   * backoff and circuit breaker like any other unreachable one, which is
   * visible rather than silent.  It also needs no option, so there is no way
   * to configure the hole back open.
   *
   * The `Location` is the redirector's string, so it goes through the same
   * redaction `HttpClient` applies to one — a `Location` carrying userinfo
   * would otherwise put a credential into a log line and a
   * `BrokerDisconnected` event.
   */
  private refuseRedirect(response: FetchResponse): void {
    // The 3xx class, and only with a `Location`: that pair is exactly what the
    // runtime would have followed.  A 304 or a bodyless 300 carries none and
    // is left to the ordinary `response.ok` check.
    if (response.status < 300 || response.status >= 400) return;
    const location = response.headers.get('location');
    if (location === null) return;
    throw new Error(
      `SSE connect refused a redirect: HTTP ${response.status} to `
      + `${redactUrlCredentials(location)}.  Redirects are never followed, because every `
      + 'custom request header — vendor API keys included — would be replayed to the '
      + 'redirect target.  Point `url` at the final endpoint.',
    );
  }

  /**
   * Refuse a body that does not announce itself as `text/event-stream` (#787).
   *
   * Nothing downstream of here can tell a feed from anything else: `consume`
   * splits whatever arrives on `\n\n` and forwards every block that parses to
   * a `data:` field, so an endpoint that answers the request with some other
   * document has a channel into the application's event handling for free.
   * The `Accept` header asks for the right type; this is the half that checks
   * the answer.
   *
   * A missing header is refused too.  It is the SSE specification's required
   * type, the ask is explicit, and treating "absent" as "probably fine" would
   * leave the check trivially bypassable by the only party it constrains.
   */
  private requireEventStreamContentType(response: FetchResponse): void {
    const contentType = response.headers.get('content-type') ?? '';
    // Trimmed and lowercased because the parameters (`; charset=utf-8`) and
    // the case of a media type are both the server's to choose.
    if (contentType.trim().toLowerCase().startsWith('text/event-stream')) return;
    throw new Error(
      `SSE connect refused a non-event-stream body: content-type ${contentType || '<absent>'}, `
      + 'expected text/event-stream.',
    );
  }

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

/**
 * The subset of `Headers` this actor reads off a response.  An `interface`
 * because it prescribes a function head; the two shapes beside it are plain
 * data and stay `type`s.
 */
interface FetchResponseHeaders {
  get(name: string): string | null;
}

/**
 * The subset of a `fetch` `Response` this actor reads.
 *
 * `headers` is here because neither the redirect refusal nor the content-type
 * assertion was *expressible* before it: the declaration exposed `ok`,
 * `status` and `body` only, so the `Location` of a 3xx and the type of the
 * body were both invisible to this file (#787).
 */
type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: FetchResponseHeaders;
  readonly body: ReadableStream<Uint8Array> | null;
};

/**
 * The subset of `RequestInit` this actor sends.
 *
 * `redirect` is **required**, which is the point: omitting it is what let the
 * runtime default of `'follow'` apply, and a required field turns forgetting
 * it back into a compile error rather than a silent policy (#787).
 */
type FetchRequestOptions = {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly redirect: 'follow' | 'error' | 'manual';
  readonly signal?: AbortSignal;
};

interface FetchModule {
  (url: string, options: FetchRequestOptions): Promise<FetchResponse>;
}

const fetchLazy: Lazy<Promise<FetchModule>> = Lazy.of(async () => {
  const fetchImpl = (globalThis as { fetch?: FetchModule }).fetch;
  if (typeof fetchImpl === 'function') return fetchImpl;
  throw new Error(
    'SseActor needs a global `fetch` (Bun, Node, and Deno all provide one).  '
    + 'In bundled/edge environments, ensure `globalThis.fetch` is not stripped.',
  );
});
