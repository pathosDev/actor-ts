/**
 * Typed WebSocket **client** actor.  The counterpart to
 * {@link WebsocketServerActor}: it dials a URL and speaks the same typed,
 * codec-encoded protocol.  Built on {@link BrokerActor}, so it inherits
 * reconnect-with-backoff, an outbound buffer that survives reconnects, a
 * circuit breaker, and HOCON options resolution for free.
 *
 *     class FeedClient extends WebsocketClientActor<ClientMessage, ServerMessage> {
 *       constructor() {
 *         super(WebsocketClientOptions.create<ClientMessage, ServerMessage>()
 *           .withUrl('ws://localhost:8080/ws'));
 *       }
 *       override onConnected(): void { this.send({ kind: 'ping', n: 1 }); }
 *       onMessage(message: ServerMessage): void { this.log.info(`pong ${message.n}`); }
 *     }
 *
 * `TOut` (what the client sends) comes first, then `TIn` (decoded server
 * messages).  Lifecycle events (connected / disconnected / inbound) are
 * delivered through the mailbox, so `onMessage` and the hooks always run
 * on the actor thread.  Other actors can push a typed send with
 * `ref.tell(websocketSend(message))`.
 */
import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { BrokerActor, type OutboundEnvelope } from '../../io/broker/BrokerActor.js';
import { redactedUrlLabel } from '../../util/RedactUrlCredentials.js';
import { jsonCodec, WebsocketDecodeError, type WebsocketCodec } from './WebsocketCodec.js';
import { WebsocketClientOptionsValidator } from './WebsocketClientOptions.js';
import type { WebsocketClientOptions, WebsocketClientOptionsType } from './WebsocketClientOptions.js';
import {
  websocketClientConnected,
  websocketClientDisconnected,
  websocketClientInbound,
  websocketClientInvalid,
  type WebsocketClientDisconnected,
  type WebsocketClientInbound,
  type WebsocketClientInvalid,
  type WebsocketClientSend,
  type WebsocketClientMessage,
  type WebsocketClientSignal,
} from './WebsocketMessages.js';
import { websocketClientConstructor, type WebsocketLike } from './WebsocketConstructor.js';
import {
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  MAXIMUM_INBOUND_SHAPE_LABEL_LENGTH,
} from '../Constants.js';
import {
  frameByteLength,
  normalizeInbound,
  type WebsocketFrame,
} from './Types.js';

/**
 * A short, log-safe name for an inbound payload that could not be normalised:
 * the constructor's name (`Blob`, `MessageEvent`, `Number`), never the value.
 * Truncated because a hand-rolled socket could in principle hand over an object
 * whose constructor name is peer-influenced, and this line is written from a
 * path a peer triggers.
 */
function inboundShapeLabel(data: unknown): string {
  if (data === null) return 'null';
  if (data === undefined) return 'undefined';
  const name = (data as { constructor?: { name?: unknown } }).constructor?.name;
  const label = typeof name === 'string' && name.length > 0 ? name : typeof data;
  return label.slice(0, MAXIMUM_INBOUND_SHAPE_LABEL_LENGTH);
}

export abstract class WebsocketClientActor<TOut, TIn, TSelf = never>
  extends BrokerActor<WebsocketClientOptionsType<TOut, TIn>, WebsocketClientMessage<TOut, TIn, TSelf>, WebsocketFrame> {

  private socket: WebsocketLike | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private _codec: WebsocketCodec<TOut, TIn> | null = null;
  /**
   * Rejects the handshake currently in flight, or `null` when none is — see
   * {@link abortConnectAttempt}.
   */
  private connectAbort: ((cause: Error) => void) | null = null;
  /**
   * Whether this connection has already reported a payload it could not
   * normalise — see {@link warnUnrecognisedFrame}.  Per connection, not per
   * actor: a shape that appears after a reconnect is worth one more line.
   */
  private unrecognisedFrameWarned = false;
  /**
   * Whether the "this keepalive cannot send anything" warning has been
   * emitted — see {@link armKeepAlive}.  Per actor, not per connection:
   * neither input to that verdict (the runtime's `WebSocket` and this class's
   * own hook) can change across a reconnect, so a second line would be the
   * same sentence again once per reconnect, forever.
   */
  private keepAliveWarned = false;

  constructor(options: WebsocketClientOptions<TOut, TIn> = {}) {
    super(options);
  }

  /* ----------------------- user overrides ------------------------ */

  /** Handle one decoded server message. */
  abstract onMessage(message: TIn): void | Promise<void>;

  /** The connection (re)opened.  A good place to send an initial handshake. */
  protected onConnected(): void | Promise<void> {}
  /** The connection dropped; a reconnect cycle may follow (per options). */
  protected onDisconnected(_cause?: Error): void | Promise<void> {}
  /** An inbound frame failed to decode.  Only called when onInvalidMessage is 'hook'. */
  protected onInvalidMessage(_error: WebsocketDecodeError): void | Promise<void> {}
  /**
   * The frame the keepalive timer puts on the wire every `pingIntervalMs`, or
   * `null` to send nothing on this tick.  Default: `null`.
   *
   * Override it when the connection has to stay warm through a middlebox that
   * inspects **payload rather than frames** — which is the whole of what an
   * application-level keepalive does that a protocol-level ping cannot.  The
   * framework supplies no default frame on purpose: any bytes it invented
   * would be an unannounced message in *your* protocol, and a peer that closes
   * on an unknown message would be severed by its own keepalive.
   *
   * The frame goes out through {@link sendRaw}, so it bypasses the codec —
   * encode it yourself if the protocol has a heartbeat message of its own:
   *
   *     protected override keepAliveFrame(): WebsocketFrame {
   *       return { kind: 'text', data: JSON.stringify({ kind: 'heartbeat' }) };
   *     }
   *
   * Overriding this method is also what tells the connect-time check that a
   * keepalive is possible at all (see {@link armKeepAlive}).  A tick on which
   * it returns `null` falls back to the runtime's native `ping()` where there
   * is one — so a subclass that overrides it and then always returns `null`
   * gets a timer that may send nothing, by its own choice and without the
   * warning an un-overridden hook earns.
   */
  protected keepAliveFrame(): WebsocketFrame | null { return null; }
  /**
   * App-level message told to this actor's ref (reachable only when TSelf ≠ never).
   *
   * A `Terminated` from a `context.watch` of your own no longer arrives here —
   * `BrokerActor` intercepts it and offers `onTerminated` instead (#709).
   */
  protected onSelfMessage(message: TSelf): void | Promise<void> {
    this.log.warn(`WebsocketClientActor: unhandled self message: ${String(message)}`);
  }

  /* ----------------------- helpers ------------------------------- */

  /**
   * Encode + enqueue an outbound message.  Buffered while disconnected and
   * resent after reconnect (BrokerActor machinery).  Returns false if the
   * message was dropped (encode failure or buffer overflow).
   */
  protected send(message: TOut): boolean {
    let frame: WebsocketFrame;
    try {
      frame = this.codec().encode(message);
    } catch (err) {
      this.log.error(`WebsocketClientActor: encode failed, dropping message: ${(err as Error).message}`);
      return false;
    }
    return this.enqueueOutbound(frame);
  }

  /** Send a raw frame, bypassing the codec. */
  protected sendRaw(frame: WebsocketFrame): boolean {
    return this.enqueueOutbound(frame);
  }

  private codec(): WebsocketCodec<TOut, TIn> {
    return (this._codec ??= this.options.codec ?? jsonCodec<TOut, TIn>());
  }

  /* ----------------------- sealed dispatch ----------------------- */

  /** @internal Sealed — override onMessage + hooks instead. */
  protected override onCommand(
    command: WebsocketClientMessage<TOut, TIn, TSelf>,
  ): void | Promise<void> {
    // Matched against the envelope union rather than the mailbox type: `TSelf`
    // is an open type parameter, and ts-pattern cannot build a `Pattern<>` for
    // a union that still contains one.  `.otherwise` is reached exactly when
    // none of our kinds hit, i.e. for an app-level `TSelf` message.
    const envelope = command as WebsocketClientSend<TOut> | WebsocketClientSignal<TIn>;
    return match(envelope)
      .with({ kind: 'websocket-client-send' }, (c) => this.onWebsocketClientSend(c))
      .with({ kind: 'websocket-client-inbound' }, (c) => this.onWebsocketClientInbound(c))
      .with({ kind: 'websocket-client-invalid' }, (c) => this.onWebsocketClientInvalid(c))
      .with({ kind: 'websocket-client-connected' }, () => this.onWebsocketClientConnected())
      .with({ kind: 'websocket-client-disconnected' }, (c) => this.onWebsocketClientDisconnected(c))
      .otherwise(() => this.onSelfMessage(command as TSelf));
  }

  /* --------------------- dispatch arm handlers -------------------- */
  /* Each unwraps one envelope onto the matching user-facing hook. */

  private onWebsocketClientSend(command: WebsocketClientSend<TOut>): void {
    this.send(command.message);
  }

  private onWebsocketClientInbound(signal: WebsocketClientInbound<TIn>): void | Promise<void> {
    return this.onMessage(signal.message);
  }

  private onWebsocketClientInvalid(signal: WebsocketClientInvalid): void | Promise<void> {
    return this.onInvalidMessage(signal.error);
  }

  private onWebsocketClientConnected(): void | Promise<void> {
    return this.onConnected();
  }

  private onWebsocketClientDisconnected(signal: WebsocketClientDisconnected): void | Promise<void> {
    return this.onDisconnected(signal.cause);
  }

  /* ----------------------- BrokerActor plumbing ------------------ */

  protected configKey(): string { return ConfigKeys.io.broker.websocket; }
  protected builtInDefaultOptions(): Partial<WebsocketClientOptionsType<TOut, TIn>> { return {}; }
  protected requiredOptions(): ReadonlyArray<keyof WebsocketClientOptionsType<TOut, TIn>> { return ['url']; }
  protected override optionsValidator(): WebsocketClientOptionsValidator<TOut, TIn> {
    return new WebsocketClientOptionsValidator<TOut, TIn>();
  }
  protected endpointLabel(): string { return this.options.url ?? '<unknown>'; }

  protected readOptionsFromConfig(config: Config): Partial<WebsocketClientOptionsType<TOut, TIn>> {
    const out: { -readonly [K in keyof WebsocketClientOptionsType<TOut, TIn>]?: WebsocketClientOptionsType<TOut, TIn>[K] } = {};
    if (config.hasPath('url')) out.url = config.getString('url');
    if (config.hasPath('protocols')) out.protocols = config.getStringList('protocols');
    if (config.hasPath('pingIntervalMs')) out.pingIntervalMs = config.getDuration('pingIntervalMs');
    if (config.hasPath('maxFrameBytes')) out.maxFrameBytes = config.getBytes('maxFrameBytes');
    if (config.hasPath('idleTimeoutMs')) out.idleTimeoutMs = config.getDuration('idleTimeoutMs');
    if (config.hasPath('connectTimeoutMs')) out.connectTimeoutMs = config.getDuration('connectTimeoutMs');
    return out;
  }

  protected override idleTimeoutMs(): number | undefined { return this.options.idleTimeoutMs; }
  protected override connectTimeoutMs(): number | undefined { return this.options.connectTimeoutMs; }

  /**
   * Route an elapsed read-idle deadline through the same door a `close` event
   * uses, so `onDisconnected` fires and the keepalive timer stops whether
   * the drop was observed or merely deduced.  The explicit `close()` is the difference
   * between the two: after a `close` event the socket is already gone, while
   * an idle timeout fires on one that is still nominally open — and on the
   * connection this feature exists for, still holding a TCP socket to a peer
   * that is not there.
   */
  protected override handleIdleTimeout(cause: Error): void {
    if (this.socket) { try { this.socket.close(); } catch { /* ignore */ } }
    this.onSocketDown(cause);
  }

  /**
   * Fail the in-flight handshake the base class has given up on.
   *
   * `close()` on a socket that never opened does not reliably raise `error`
   * on every runtime, so the pending promise is rejected directly and the
   * socket closed alongside it — otherwise the deadline would fire, the
   * handshake would stay pending, and the reconnect cycle would never start.
   */
  protected override abortConnectAttempt(cause: Error): void {
    this.connectAbort?.(cause);
  }

  /**
   * Ask the socket for `ArrayBuffer` binary payloads instead of taking the
   * runtime's default.
   *
   * The defaults disagree, and the disagreement was silently losing traffic:
   * measured over a real connection, Bun 1.4.0 hands the `message` listener a
   * `Buffer`, while Node 26.7.0 and Deno 2.6.8 hand it a **`Blob`**.  A `Blob`
   * carries `size`, not `byteLength`, and is neither `ArrayBuffer` nor
   * `Uint8Array` nor an array, so it matched no branch of
   * {@link normalizeInbound} — every binary frame was dropped as
   * "unrecognised" on those two runtimes, at any size, and `maxFrameBytes`
   * never saw it either, which quietly reopened #750 for binary frames.
   *
   * The alternative fix — teaching `normalizeInbound` about `Blob` — was
   * rejected, and the reason is the `await` it needs.  `Blob` yields its bytes
   * only through `arrayBuffer()`, so `handleInbound` would have to resume on a
   * later microtask, and two things break there.  Frame **order** stops being
   * guaranteed: `handleInbound` is called straight from the socket's event
   * listener, and today the `self.tell` per frame happens in arrival order by
   * construction; behind a promise it happens in resolution order, which is
   * not specified to match.  And the `maxFrameBytes` check moves behind that
   * microtask, so a peer's *next* oversize frame is already in flight before
   * the close for the first is issued — the precise property #750 exists to
   * provide.  (`Blob.size` would keep the size check synchronous, but the
   * decode still could not be, so the ordering problem stands.)  Setting
   * `binaryType` costs one assignment at dial time and keeps the whole inbound
   * path synchronous, so that is the mechanism, and `normalizeInbound` stays
   * `Blob`-free on purpose.
   *
   * Set here rather than in {@link websocketClientConstructor} because this is
   * the code whose correctness depends on it: `WebsocketClientConstructor` is
   * an exported seam, and a custom one — or the test override — would
   * otherwise reintroduce the defect from outside this file.  Guarded, since a
   * hand-rolled `WebsocketLike` may define the property as read-only or not at
   * all; the value is advisory and a socket that ignores it lands on the
   * unrecognised-frame path, which now says so once and names the shape.
   */
  private requestArrayBufferPayloads(ws: WebsocketLike): void {
    try { ws.binaryType = 'arraybuffer'; } catch { /* socket does not offer it */ }
  }

  /**
   * Start the keepalive timer for a freshly opened socket — or, when the
   * configured interval has nothing it could send, say so once and start
   * nothing.
   *
   * `pingIntervalMs` used to arm `setInterval(() => ws.ping?.())`
   * unconditionally, and `ping()` is not part of the WHATWG `WebSocket`
   * interface.  Measured on this repository's supported runtimes it exists on
   * Bun and on neither Node nor Deno, so on two of the three the optional call
   * plus the empty `catch` made the timer a guaranteed no-op: a documented
   * mitigation putting zero bytes on the wire and saying nothing about it,
   * while a blackholed connection stayed `connected` and every send went
   * nowhere (#751).  **A timer that provably cannot send is worse than no
   * timer**, because it is the thing that persuades an operator the connection
   * is being kept warm — hence the refusal to arm one, and the warning in its
   * place.
   *
   * Whether {@link keepAliveFrame} is overridden is read off the prototype
   * rather than probed by calling it.  A probe cannot tell "this class has no
   * keepalive" from "the application has nothing to say right now", and those
   * want opposite answers here; the identity comparison asks the question that
   * is actually being asked, with no side effect and no speculative frame.
   */
  private armKeepAlive(ws: WebsocketLike): void {
    const intervalMs = this.options.pingIntervalMs;
    if (!intervalMs || intervalMs <= 0) return;
    const hasApplicationFrame = this.keepAliveFrame !== WebsocketClientActor.prototype.keepAliveFrame;
    const hasNativePing = typeof ws.ping === 'function';
    if (!hasApplicationFrame && !hasNativePing) {
      this.warnKeepAliveUnsendable(intervalMs);
      return;
    }
    this.keepAliveTimer = setInterval(() => this.sendKeepAlive(ws), intervalMs);
  }

  /**
   * One keepalive tick: the application's frame when there is one, otherwise
   * the runtime's native control frame.
   *
   * The order is the point.  An application frame is the only kind a proxy
   * that inspects payload can see, and the only kind a peer's own
   * application-level read deadline counts; `ping()` emits a protocol control
   * frame, which is a different thing and is not delivered to the peer's
   * `message` listener on any supported runtime.  It stays as the fallback
   * rather than being dropped, so a tick on which the hook has nothing to say
   * does not silently become no traffic at all on the one runtime that can
   * still send something.
   */
  private sendKeepAlive(ws: WebsocketLike): void {
    const frame = this.keepAliveFrame();
    if (frame !== null) {
      this.sendRaw(frame);
      return;
    }
    // A socket that refuses a ping is not a reason to drop a connection that
    // is otherwise working — but unlike before, this catch can no longer be
    // hiding a method that was never there: `armKeepAlive` checked.
    try { ws.ping?.(); } catch { /* ignore */ }
  }

  /**
   * Report a configured `pingIntervalMs` that cannot put anything on the wire.
   *
   * Written as an instruction rather than a diagnosis: the operator who set
   * the interval wanted a keepalive, and both ways to actually get one belong
   * in the line that tells them they have not.  {@link idleTimeoutMs} is named
   * alongside because it answers the failure the keepalive was reached for —
   * a keepalive stops a proxy *closing* an idle connection, and only the read
   * deadline notices one that was dropped anyway.
   */
  private warnKeepAliveUnsendable(intervalMs: number): void {
    if (this.keepAliveWarned) return;
    this.keepAliveWarned = true;
    this.log.warn(
      `WebsocketClientActor: pingIntervalMs is set (${intervalMs} ms) on `
      + `${this.redactedEndpointLabel()}, but nothing can be sent — this runtime's WebSocket has `
      + 'no ping() and keepAliveFrame() is not overridden, so no keepalive timer was started. '
      + 'Override keepAliveFrame() to supply an application-level frame, and set idleTimeoutMs so '
      + 'a connection dropped anyway is still detected.',
    );
  }

  protected async connectImplementation(): Promise<void> {
    const ctor = await websocketClientConstructor.get();
    const ws = ctor.create(this.options.url!, {
      protocols: this.options.protocols,
    });
    this.requestArrayBufferPayloads(ws);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.connectAbort = (cause: Error): void => {
        if (settled) return;
        settled = true;
        this.connectAbort = null;
        try { ws.close(); } catch { /* ignore */ }
        reject(cause);
      };
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        this.connectAbort = null;
        this.socket = ws;
        this.unrecognisedFrameWarned = false;
        ws.addEventListener('message', (ev: { data: unknown }) => this.handleInbound(ev.data));
        ws.addEventListener('close', () => this.onSocketDown(new Error('websocket closed')));
        ws.addEventListener('error', () => this.onSocketDown(new Error('websocket error')));
        this.armKeepAlive(ws);
        this.self.tell(websocketClientConnected());
        resolve();
      });
      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        this.connectAbort = null;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('websocket connect error'));
      });
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    const sock = this.socket;
    this.socket = null;
    if (sock) { try { sock.close(); } catch { /* ignore */ } }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<WebsocketFrame>): Promise<void> {
    if (!this.socket) throw new Error('WebsocketClientActor: not open');
    this.socket.send(env.payload.data);
  }

  /* ----------------------- inbound ------------------------------- */

  private onSocketDown(cause: Error): void {
    if (!this.socket) return; // already handled this connection's drop
    this.socket = null;
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    this.self.tell(websocketClientDisconnected(cause));
    // Trigger BrokerActor's reconnect cycle.
    this.handleConnectionLost(cause);
  }

  /**
   * An inbound frame breached `maxFrameBytes`: close with 1009 and enter the
   * reconnect cycle.
   *
   * Closing rather than dropping is the *whole* of the protection available
   * here, and it is worth being precise about what it does and does not buy.
   * It buys nothing against the first frame — by the time this runs the
   * runtime has already reassembled the payload on the heap, and no supported
   * runtime's native `WebSocket` accepts a payload limit that would have
   * stopped it (measured; see {@link websocketClientConstructor}).  What it
   * buys is that the allocation is not *repeatable* on this connection: the
   * previous bare `return` left the socket open, so a hostile peer could spend
   * the same heap again, once per frame, for as long as it cared to — and
   * emit one warning line per attempt with it (#750).  A peer that wants
   * another round now has to pay for a full reconnect, which the inherited
   * backoff and circuit breaker already throttle.
   *
   * Routed through {@link onSocketDown} rather than `handleConnectionLost`
   * directly because the close is *ours*: the peer need not answer it, so
   * nothing else would clear `keepAliveTimer`, null `this.socket`, or emit
   * `websocketClientDisconnected`.  Calling `handleConnectionLost` bare would
   * start a reconnect while the old handle and its keepalive timer were
   * still live.
   */
  private rejectOversizeFrame(cap: number): void {
    // A label, not the configured URL: whatever the URL carries would
    // otherwise be replayed into the log at a peer's prompting.  The close
    // below bounds that to one line per dial rather than one per frame, which
    // is why #592's latch clause was never needed — but the redaction still
    // stands, because the peer still chooses how many dials it provokes.
    // `redactedUrlLabel` drops the query string as well as the userinfo — a
    // WebSocket endpoint is commonly authenticated with a `?token=…` — while
    // keeping the path, which is what tells two connections to the same host
    // apart (#592).
    const endpoint = redactedUrlLabel(this.options.url ?? '<unknown>');
    this.log.warn(
      `WebsocketClientActor: oversize inbound frame (> ${cap} bytes) from ${endpoint} — closing with 1009`,
    );
    // 1009 is RFC 6455 "Message Too Big".  Order matters, and not the way it
    // first looks: `onSocketDown` ignores every call after the first (it nulls
    // `this.socket` as its guard), and `close()` makes the runtime fire our own
    // `close` listener, which calls it with the generic 'websocket closed'.
    // Closing first therefore left the cause a race the runtime decides —
    // measured on the `engines` floor, Bun 1.3.0 delivered 'websocket closed'
    // where 1.4.0 delivered this one, so an operator on the floor lost the
    // sentence saying *why* the connection went. Recording the specific cause
    // before the close settles it everywhere; the socket is captured first
    // because `onSocketDown` clears the field.
    const socket = this.socket;
    this.onSocketDown(new Error('oversize inbound frame'));
    try { socket?.close(1009, 'message too big'); } catch { /* ignore */ }
  }

  /**
   * Report a payload {@link normalizeInbound} could not turn into a frame —
   * once per connection, naming the shape.
   *
   * Both halves are the lesson of the `Blob` regression this method was
   * written for.  **Naming the shape**, because the old line said only
   * "unrecognised inbound frame type" and that is unactionable: it is the same
   * sentence whether the socket handed us a `Blob`, a `MessageEvent` nobody
   * unwrapped, or a number, and the answer differs in each case.  **Latching**,
   * because the volume is the peer's to choose: a frame per line is the
   * unbounded, remote-driven log #750 closed for the oversize path, and the
   * reason a `Blob` survived unnoticed is that it looked like ordinary noise
   * repeated forever.  Unlike an oversize frame this does not close the
   * connection: an unrecognised shape is far more often our own end
   * misconfigured — it was, here — and the payload is released immediately, so
   * it is not the repeatable allocation that made closing right in #750.
   *
   * The label is a constructor name, not the payload, and it is length-capped:
   * nothing about the value itself reaches the log.
   */
  private warnUnrecognisedFrame(data: unknown): void {
    if (this.unrecognisedFrameWarned) return;
    this.unrecognisedFrameWarned = true;
    this.log.warn(
      `WebsocketClientActor: unrecognised inbound frame type (${inboundShapeLabel(data)}) — dropped; `
      + 'further occurrences on this connection are not logged',
    );
  }

  private handleInbound(data: unknown): void {
    // First, before every reason this frame might be rejected: an
    // unrecognised, oversize or undecodable frame is still the peer speaking,
    // and the read-idle deadline asks whether it is there, not whether it is
    // behaving (#753).
    this.noteInboundActivity();
    const frame = normalizeInbound(data);
    if (!frame) {
      this.warnUnrecognisedFrame(data);
      return;
    }
    const cap = this.options.maxFrameBytes ?? DEFAULT_WEBSOCKET_MAX_FRAME_BYTES;
    if (frameByteLength(frame) > cap) {
      this.rejectOversizeFrame(cap);
      return;
    }
    let decoded: TIn;
    try {
      decoded = this.codec().decode(frame);
    } catch (err) {
      const decodeError = err instanceof WebsocketDecodeError ? err : new WebsocketDecodeError(String(err), frame);
      const policy = this.options.onInvalidMessage ?? 'drop';
      if (policy === 'hook') {
        this.self.tell(websocketClientInvalid(decodeError));
      } else if (policy === 'disconnect') {
        this.log.warn(`WebsocketClientActor: invalid inbound message — disconnecting: ${decodeError.message}`);
        try { this.socket?.close(1003, 'unsupported data'); } catch { /* ignore */ }
      } else {
        this.log.warn(`WebsocketClientActor: invalid inbound message — dropped: ${decodeError.message}`);
      }
      return;
    }
    this.self.tell(websocketClientInbound(decoded));
  }
}
