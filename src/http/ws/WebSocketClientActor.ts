/**
 * Typed WebSocket **client** actor.  The counterpart to
 * {@link WebSocketServerActor}: it dials a URL and speaks the same typed,
 * codec-encoded protocol.  Built on {@link BrokerActor}, so it inherits
 * reconnect-with-backoff, an outbound buffer that survives reconnects, a
 * circuit breaker, and HOCON settings resolution for free.
 *
 *     class FeedClient extends WebSocketClientActor<ClientMsg, ServerMsg> {
 *       constructor() {
 *         super(WebSocketClientOptions.create<ClientMsg, ServerMsg>()
 *           .withUrl('ws://localhost:8080/ws'));
 *       }
 *       override onConnected(): void { this.send({ kind: 'ping', n: 1 }); }
 *       onMessage(msg: ServerMsg): void { this.log.info(`pong ${msg.n}`); }
 *     }
 *
 * `TOut` (what the client sends) comes first, then `TIn` (decoded server
 * messages).  Lifecycle events (connected / disconnected / inbound) are
 * delivered through the mailbox, so `onMessage` and the hooks always run
 * on the actor thread.  Other actors can push a typed send with
 * `ref.tell(wsSend(msg))`.
 */
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { BrokerActor, type OutboundEnvelope } from '../../io/broker/BrokerActor.js';
import type { BrokerCommonSettings } from '../../io/broker/BrokerSettings.js';
import { jsonCodec, WsDecodeError, type WsCodec } from './WsCodec.js';
import type { WebSocketClientOptions } from './WebSocketClientOptions.js';
import {
  WsClientConnected,
  WsClientDisconnected,
  WsClientInbound,
  WsClientInvalid,
  WsClientSend,
  type WsClientMessage,
} from './WsMessages.js';
import { wsClientCtor, type WebSocketLike } from './wsCtor.js';
import {
  DEFAULT_WS_MAX_FRAME_BYTES,
  frameByteLength,
  normalizeInbound,
  type WsFrame,
} from './types.js';

export interface WebSocketClientSettings<TOut = unknown, TIn = unknown> extends BrokerCommonSettings {
  /** WebSocket URL (`ws://…` or `wss://…`).  Required (ctor or HOCON). */
  readonly url?: string;
  readonly protocols?: string | ReadonlyArray<string>;
  /** Custom request headers — Node/`ws` only; native/browsers ignore them. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  readonly codec?: WsCodec<TOut, TIn>;
  /** Inbound frame size cap; oversize frames are dropped with a warning.  Default 1 MiB. */
  readonly maxFrameBytes?: number;
  /** What to do with an inbound frame the codec can't decode.  Default 'drop'. */
  readonly onInvalidMessage?: 'drop' | 'hook' | 'disconnect';
  /** Send a ping every `pingIntervalMs` to keep the connection alive.  Default: disabled. */
  readonly pingIntervalMs?: number;
}

export abstract class WebSocketClientActor<TOut, TIn, TSelf = never>
  extends BrokerActor<WebSocketClientSettings<TOut, TIn>, WsClientMessage<TOut, TIn, TSelf>, WsFrame> {

  private socket: WebSocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private _codec: WsCodec<TOut, TIn> | null = null;

  constructor(options: WebSocketClientOptions<TOut, TIn> | Partial<WebSocketClientSettings<TOut, TIn>> = {}) {
    super(options);
  }

  /* ----------------------- user overrides ------------------------ */

  /** Handle one decoded server message. */
  abstract onMessage(msg: TIn): void | Promise<void>;

  /** The connection (re)opened.  A good place to send an initial handshake. */
  protected onConnected(): void | Promise<void> {}
  /** The connection dropped; a reconnect cycle may follow (per settings). */
  protected onDisconnected(_cause?: Error): void | Promise<void> {}
  /** An inbound frame failed to decode.  Only called when onInvalidMessage is 'hook'. */
  protected onInvalidMessage(_error: WsDecodeError): void | Promise<void> {}
  /** App-level message told to this actor's ref (reachable only when TSelf ≠ never). */
  protected onSelfMessage(msg: TSelf): void | Promise<void> {
    this.log.warn(`WebSocketClientActor: unhandled self message: ${String(msg)}`);
  }

  /* ----------------------- helpers ------------------------------- */

  /**
   * Encode + enqueue an outbound message.  Buffered while disconnected and
   * resent after reconnect (BrokerActor machinery).  Returns false if the
   * message was dropped (encode failure or buffer overflow).
   */
  protected send(msg: TOut): boolean {
    let frame: WsFrame;
    try {
      frame = this.codec().encode(msg);
    } catch (err) {
      this.log.error(`WebSocketClientActor: encode failed, dropping message: ${(err as Error).message}`);
      return false;
    }
    return this.enqueueOutbound(frame);
  }

  /** Send a raw frame, bypassing the codec. */
  protected sendRaw(frame: WsFrame): boolean {
    return this.enqueueOutbound(frame);
  }

  private codec(): WsCodec<TOut, TIn> {
    return (this._codec ??= this.settings.codec ?? jsonCodec<TOut, TIn>());
  }

  /* ----------------------- sealed dispatch ----------------------- */

  /** @internal Sealed — override onMessage + hooks instead. */
  override onReceive(cmd: WsClientMessage<TOut, TIn, TSelf>): void | Promise<void> {
    if (cmd instanceof WsClientSend) return void this.send(cmd.msg as TOut);
    if (cmd instanceof WsClientInbound) return this.onMessage(cmd.msg as TIn);
    if (cmd instanceof WsClientInvalid) return this.onInvalidMessage(cmd.error);
    if (cmd instanceof WsClientConnected) return this.onConnected();
    if (cmd instanceof WsClientDisconnected) return this.onDisconnected(cmd.cause);
    return this.onSelfMessage(cmd as TSelf);
  }

  /* ----------------------- BrokerActor plumbing ------------------ */

  protected configKey(): string { return ConfigKeys.io.broker.websocket; }
  protected builtInDefaults(): Partial<WebSocketClientSettings<TOut, TIn>> { return {}; }
  protected requiredSettings(): ReadonlyArray<keyof WebSocketClientSettings<TOut, TIn>> { return ['url']; }
  protected endpointLabel(): string { return this.settings.url ?? '<unknown>'; }

  protected readSettingsFromConfig(c: Config): Partial<WebSocketClientSettings<TOut, TIn>> {
    const out: { -readonly [K in keyof WebSocketClientSettings<TOut, TIn>]?: WebSocketClientSettings<TOut, TIn>[K] } = {};
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

  protected async connectImpl(): Promise<void> {
    const ctor = await wsClientCtor.get();
    const ws = ctor.create(this.settings.url!, {
      protocols: this.settings.protocols,
      headers: this.settings.headers,
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
        const ping = this.settings.pingIntervalMs;
        if (ping && ping > 0) {
          this.pingTimer = setInterval(() => { try { ws.ping?.(); } catch { /* ignore */ } }, ping);
        }
        this.self.tell(new WsClientConnected());
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

  protected async disconnectImpl(): Promise<void> {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    const sock = this.socket;
    this.socket = null;
    if (sock) { try { sock.close(); } catch { /* ignore */ } }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<WsFrame>): Promise<void> {
    if (!this.socket) throw new Error('WebSocketClientActor: not open');
    this.socket.send(env.payload.data);
  }

  /* ----------------------- inbound ------------------------------- */

  private onSocketDown(cause: Error): void {
    if (!this.socket) return; // already handled this connection's drop
    this.socket = null;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.self.tell(new WsClientDisconnected(cause));
    // Trigger BrokerActor's reconnect cycle.
    this.handleConnectionLost(cause);
  }

  private handleInbound(data: unknown): void {
    const frame = normalizeInbound(data);
    if (!frame) {
      this.log.warn('WebSocketClientActor: unrecognised inbound frame type — dropped');
      return;
    }
    const cap = this.settings.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES;
    if (frameByteLength(frame) > cap) {
      this.log.warn(`WebSocketClientActor: dropped oversize inbound frame (> ${cap} bytes) from ${this.settings.url}`);
      return;
    }
    let decoded: TIn;
    try {
      decoded = this.codec().decode(frame);
    } catch (err) {
      const e = err instanceof WsDecodeError ? err : new WsDecodeError(String(err), frame);
      const policy = this.settings.onInvalidMessage ?? 'drop';
      if (policy === 'hook') {
        this.self.tell(new WsClientInvalid(e));
      } else if (policy === 'disconnect') {
        this.log.warn(`WebSocketClientActor: invalid inbound message — disconnecting: ${e.message}`);
        try { this.socket?.close(1003, 'unsupported data'); } catch { /* ignore */ }
      } else {
        this.log.warn(`WebSocketClientActor: invalid inbound message — dropped: ${e.message}`);
      }
      return;
    }
    this.self.tell(new WsClientInbound(decoded));
  }
}
