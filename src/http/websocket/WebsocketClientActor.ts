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
 *       onMessage(msg: ServerMessage): void { this.log.info(`pong ${msg.n}`); }
 *     }
 *
 * `TOut` (what the client sends) comes first, then `TIn` (decoded server
 * messages).  Lifecycle events (connected / disconnected / inbound) are
 * delivered through the mailbox, so `onMessage` and the hooks always run
 * on the actor thread.  Other actors can push a typed send with
 * `ref.tell(websocketSend(msg))`.
 */
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { BrokerActor, type OutboundEnvelope } from '../../io/broker/BrokerActor.js';
import { jsonCodec, WebsocketDecodeError, type WebsocketCodec } from './WebsocketCodec.js';
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
} from './WebsocketMessages.js';
import { websocketClientConstructor, type WebsocketLike } from './websocketConstructor.js';
import {
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  frameByteLength,
  normalizeInbound,
  type WebsocketFrame,
} from './types.js';

export abstract class WebsocketClientActor<TOut, TIn, TSelf = never>
  extends BrokerActor<WebsocketClientOptionsType<TOut, TIn>, WebsocketClientMessage<TOut, TIn, TSelf>, WebsocketFrame> {

  private socket: WebsocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private _codec: WebsocketCodec<TOut, TIn> | null = null;

  constructor(options: WebsocketClientOptions<TOut, TIn> = {}) {
    super(options);
  }

  /* ----------------------- user overrides ------------------------ */

  /** Handle one decoded server message. */
  abstract onMessage(msg: TIn): void | Promise<void>;

  /** The connection (re)opened.  A good place to send an initial handshake. */
  protected onConnected(): void | Promise<void> {}
  /** The connection dropped; a reconnect cycle may follow (per options). */
  protected onDisconnected(_cause?: Error): void | Promise<void> {}
  /** An inbound frame failed to decode.  Only called when onInvalidMessage is 'hook'. */
  protected onInvalidMessage(_error: WebsocketDecodeError): void | Promise<void> {}
  /** App-level message told to this actor's ref (reachable only when TSelf ≠ never). */
  protected onSelfMessage(msg: TSelf): void | Promise<void> {
    this.log.warn(`WebsocketClientActor: unhandled self message: ${String(msg)}`);
  }

  /* ----------------------- helpers ------------------------------- */

  /**
   * Encode + enqueue an outbound message.  Buffered while disconnected and
   * resent after reconnect (BrokerActor machinery).  Returns false if the
   * message was dropped (encode failure or buffer overflow).
   */
  protected send(msg: TOut): boolean {
    let frame: WebsocketFrame;
    try {
      frame = this.codec().encode(msg);
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
  override onReceive(cmd: WebsocketClientMessage<TOut, TIn, TSelf>): void | Promise<void> {
    switch ((cmd as { readonly kind?: unknown }).kind) {
      case 'websocket-client-send': return void this.send((cmd as WebsocketClientSend<TOut>).message);
      case 'websocket-client-inbound': return this.onMessage((cmd as WebsocketClientInbound<TIn>).message);
      case 'websocket-client-invalid': return this.onInvalidMessage((cmd as WebsocketClientInvalid).error);
      case 'websocket-client-connected': return this.onConnected();
      case 'websocket-client-disconnected': return this.onDisconnected((cmd as WebsocketClientDisconnected).cause);
      default: return this.onSelfMessage(cmd as TSelf);
    }
  }

  /* ----------------------- BrokerActor plumbing ------------------ */

  protected configKey(): string { return ConfigKeys.io.broker.websocket; }
  protected builtInDefaultOptions(): Partial<WebsocketClientOptionsType<TOut, TIn>> { return {}; }
  protected requiredOptions(): ReadonlyArray<keyof WebsocketClientOptionsType<TOut, TIn>> { return ['url']; }
  protected endpointLabel(): string { return this.options.url ?? '<unknown>'; }

  protected readOptionsFromConfig(c: Config): Partial<WebsocketClientOptionsType<TOut, TIn>> {
    const out: { -readonly [K in keyof WebsocketClientOptionsType<TOut, TIn>]?: WebsocketClientOptionsType<TOut, TIn>[K] } = {};
    if (c.hasPath('url')) out.url = c.getString('url');
    if (c.hasPath('protocols')) out.protocols = c.getStringList('protocols');
    if (c.hasPath('pingIntervalMs')) out.pingIntervalMs = c.getDuration('pingIntervalMs');
    if (c.hasPath('maxFrameBytes')) out.maxFrameBytes = c.getBytes('maxFrameBytes');
    if (c.hasPath('headers')) {
      const obj = c.getObject('headers');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') headers[k] = v;
      out.headers = headers;
    }
    return out;
  }

  protected async connectImplementation(): Promise<void> {
    const ctor = await websocketClientConstructor.get();
    const ws = ctor.create(this.options.url!, {
      protocols: this.options.protocols,
      headers: this.options.headers,
    });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
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

  private handleInbound(data: unknown): void {
    const frame = normalizeInbound(data);
    if (!frame) {
      this.log.warn('WebsocketClientActor: unrecognised inbound frame type — dropped');
      return;
    }
    const cap = this.options.maxFrameBytes ?? DEFAULT_WEBSOCKET_MAX_FRAME_BYTES;
    if (frameByteLength(frame) > cap) {
      this.log.warn(`WebsocketClientActor: dropped oversize inbound frame (> ${cap} bytes) from ${this.options.url}`);
      return;
    }
    let decoded: TIn;
    try {
      decoded = this.codec().decode(frame);
    } catch (err) {
      const e = err instanceof WebsocketDecodeError ? err : new WebsocketDecodeError(String(err), frame);
      const policy = this.options.onInvalidMessage ?? 'drop';
      if (policy === 'hook') {
        this.self.tell(websocketClientInvalid(e));
      } else if (policy === 'disconnect') {
        this.log.warn(`WebsocketClientActor: invalid inbound message — disconnecting: ${e.message}`);
        try { this.socket?.close(1003, 'unsupported data'); } catch { /* ignore */ }
      } else {
        this.log.warn(`WebsocketClientActor: invalid inbound message — dropped: ${e.message}`);
      }
      return;
    }
    this.self.tell(websocketClientInbound(decoded));
  }
}
