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
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../Constants.js';
import {
  frameByteLength,
  normalizeInbound,
  type WebsocketFrame,
} from './Types.js';

export abstract class WebsocketClientActor<TOut, TIn, TSelf = never>
  extends BrokerActor<WebsocketClientOptionsType<TOut, TIn>, WebsocketClientMessage<TOut, TIn, TSelf>, WebsocketFrame> {

  private socket: WebsocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private _codec: WebsocketCodec<TOut, TIn> | null = null;
  /**
   * Rejects the handshake currently in flight, or `null` when none is — see
   * {@link abortConnectAttempt}.
   */
  private connectAbort: ((cause: Error) => void) | null = null;

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
  /** App-level message told to this actor's ref (reachable only when TSelf ≠ never). */
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
  override onReceive(command: WebsocketClientMessage<TOut, TIn, TSelf>): void | Promise<void> {
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
   * uses, so `onDisconnected` fires and the ping timer stops whether the drop
   * was observed or merely deduced.  The explicit `close()` is the difference
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

  protected async connectImplementation(): Promise<void> {
    const ctor = await websocketClientConstructor.get();
    const ws = ctor.create(this.options.url!, {
      protocols: this.options.protocols,
    });
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
        ws.addEventListener('message', (ev: { data: unknown }) => this.handleInbound(ev.data));
        ws.addEventListener('close', () => this.onSocketDown(new Error('websocket closed')));
        ws.addEventListener('error', () => this.onSocketDown(new Error('websocket error')));
        const ping = this.options.pingIntervalMs;
        if (ping && ping > 0) {
          this.pingTimer = setInterval(() => { try { ws.ping?.(); } catch { /* ignore */ } }, ping);
        }
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
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
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
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
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
   * nothing else would clear `pingTimer`, null `this.socket`, or emit
   * `websocketClientDisconnected`.  Calling `handleConnectionLost` bare would
   * start a reconnect while the old handle and its ping timer were still live.
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
    // 1009 is RFC 6455 "Message Too Big".  Order matters: `onSocketDown` nulls
    // `this.socket`, so the close has to be issued before it runs.
    try { this.socket?.close(1009, 'message too big'); } catch { /* ignore */ }
    this.onSocketDown(new Error('oversize inbound frame'));
  }

  private handleInbound(data: unknown): void {
    // First, before every reason this frame might be rejected: an
    // unrecognised, oversize or undecodable frame is still the peer speaking,
    // and the read-idle deadline asks whether it is there, not whether it is
    // behaving (#753).
    this.noteInboundActivity();
    const frame = normalizeInbound(data);
    if (!frame) {
      this.log.warn('WebsocketClientActor: unrecognised inbound frame type — dropped');
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
