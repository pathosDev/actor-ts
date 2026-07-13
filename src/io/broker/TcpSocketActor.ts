import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { TcpSocketOptions, TcpSocketOptionsType } from './TcpSocketOptions.js';

/**
 * Frame extraction strategy on the inbound stream.
 *
 *   - `bytes`     — every chunk delivered raw, no framing.  Subscriber
 *                   has to handle byte-stream semantics itself.
 *   - `lines`     — split on `delimiter` (default `'\n'`).  Most useful
 *                   for line-oriented protocols (HTTP/Telnet/Redis).
 *   - `length-prefixed` — first 4 bytes (big-endian uint32) carry the
 *                         payload size; what follows is the payload.
 */
export type TcpFraming =
  | { readonly kind: 'bytes' }
  | { readonly kind: 'lines'; readonly delimiter?: string; readonly maxLineLen?: number }
  | { readonly kind: 'length-prefixed'; readonly maxFrameLen?: number };

/** Outbound payload — bytes or string (auto-encoded as UTF-8). */
export type TcpOutbound = Uint8Array | string;

/**
 * TCP-socket actor.  Uses `node:net` (built into Bun, Node, and the
 * Deno node-compat layer).  Owns one outbound connection; reconnects
 * via the base class' policy on disconnect.
 *
 * Inbound frames are pushed to `target` as plain messages.  Outbound is
 * via the standard `enqueueOutbound` path — the actor exposes a small
 * command surface (`send`) so user code can `tell({ kind: 'send', payload })`.
 */
export type TcpSocketCommand =
  | { readonly kind: 'send'; readonly payload: TcpOutbound };

export class TcpSocketActor extends BrokerActor<TcpSocketOptionsType, TcpSocketCommand, TcpOutbound> {
  private socket: NetSocket | null = null;
  /** Buffer for partial frames not yet matched by the framing strategy. */
  private inboundBuffer: Uint8Array = new Uint8Array(0);

  constructor(options: TcpSocketOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.tcp; }
  protected builtInDefaultOptions(): Partial<TcpSocketOptionsType> {
    return { framing: { kind: 'bytes' } };
  }
  protected readOptionsFromConfig(config: Config): Partial<TcpSocketOptionsType> {
    const out: { -readonly [K in keyof TcpSocketOptionsType]?: TcpSocketOptionsType[K] } = {};
    if (config.hasPath('host')) out.host = config.getString('host');
    if (config.hasPath('port')) out.port = config.getInt('port');
    if (config.hasPath('framing')) {
      const framingConfig = config.getConfig('framing');
      const kind = framingConfig.getString('kind') as TcpFraming['kind'];
      if (kind === 'lines') {
        out.framing = {
          kind, delimiter: framingConfig.hasPath('delimiter') ? framingConfig.getString('delimiter') : undefined,
          maxLineLen: framingConfig.hasPath('maxLineLen') ? framingConfig.getInt('maxLineLen') : undefined,
        };
      } else if (kind === 'length-prefixed') {
        out.framing = {
          kind, maxFrameLen: framingConfig.hasPath('maxFrameLen') ? framingConfig.getInt('maxFrameLen') : undefined,
        };
      } else {
        out.framing = { kind: 'bytes' };
      }
    }
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof TcpSocketOptionsType> {
    return ['host', 'port', 'target'];
  }
  protected endpointLabel(): string { return `tcp://${this.options.host}:${this.options.port}`; }

  protected async connectImplementation(): Promise<void> {
    const net = await netLazy.get();
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.options.host!, port: this.options.port! });
      let done = false;
      sock.once('connect', () => {
        if (done) return;
        done = true;
        sock.removeAllListeners('error');
        this.socket = sock;
        sock.on('data', (chunk: Uint8Array) => this.handleData(chunk));
        sock.on('close', () => this.handleConnectionLost(new Error('socket closed')));
        sock.on('error', (e: Error) => this.handleConnectionLost(e));
        resolve();
      });
      sock.once('error', (e: Error) => {
        if (done) return;
        done = true;
        reject(e);
      });
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    if (!this.socket) return;
    const sock = this.socket;
    this.socket = null;
    return new Promise<void>((resolve) => {
      sock.removeAllListeners();
      sock.end(() => resolve());
      // Hard-cap: if `end()` doesn't fire within 1s, destroy + resolve.
      setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } resolve(); }, 1_000);
    });
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<TcpOutbound>): Promise<void> {
    if (!this.socket) throw new Error('TcpSocketActor: socket not open');
    const bytes = env.payload instanceof Uint8Array
      ? env.payload
      : new TextEncoder().encode(env.payload);
    return new Promise<void>((resolve, reject) => {
      this.socket!.write(bytes, (err) => err ? reject(err) : resolve());
    });
  }

  override onReceive(cmd: TcpSocketCommand): void {
    if (cmd.kind === 'send') this.enqueueOutbound(cmd.payload);
  }

  /* ---------------------------- framing ----------------------------- */

  private handleData(chunk: Uint8Array): void {
    // Append to buffer.
    if (this.inboundBuffer.length === 0) {
      this.inboundBuffer = chunk;
    } else {
      const merged = new Uint8Array(this.inboundBuffer.length + chunk.length);
      merged.set(this.inboundBuffer, 0);
      merged.set(chunk, this.inboundBuffer.length);
      this.inboundBuffer = merged;
    }
    const framing = this.options.framing ?? { kind: 'bytes' };
    if (framing.kind === 'bytes') {
      this.deliver(this.inboundBuffer);
      this.inboundBuffer = new Uint8Array(0);
    } else if (framing.kind === 'lines') {
      this.extractLines(framing.delimiter ?? '\n', framing.maxLineLen ?? 1_048_576);
    } else {
      this.extractLengthPrefixed(framing.maxFrameLen ?? 16 * 1024 * 1024);
    }
  }

  private extractLines(delimiter: string, maxLineLen: number): void {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(this.inboundBuffer);
    let cursor = 0;
    while (true) {
      const idx = text.indexOf(delimiter, cursor);
      if (idx < 0) break;
      const line = text.slice(cursor, idx);
      if (line.length > maxLineLen) {
        this.handleConnectionLost(new Error(`line exceeds maxLineLen=${maxLineLen}`));
        return;
      }
      this.deliver(line);
      cursor = idx + delimiter.length;
    }
    if (cursor === 0) return;
    // Re-encode the leftover suffix as bytes.
    this.inboundBuffer = new TextEncoder().encode(text.slice(cursor));
  }

  private extractLengthPrefixed(maxFrameLen: number): void {
    let cursor = 0;
    const buf = this.inboundBuffer;
    while (buf.length - cursor >= 4) {
      const len = (buf[cursor]! << 24 | buf[cursor + 1]! << 16
                 | buf[cursor + 2]! << 8 | buf[cursor + 3]!) >>> 0;
      if (len > maxFrameLen) {
        this.handleConnectionLost(new Error(`frame exceeds maxFrameLen=${maxFrameLen}`));
        return;
      }
      if (buf.length - cursor - 4 < len) break;
      const frame = buf.slice(cursor + 4, cursor + 4 + len);
      this.deliver(frame);
      cursor += 4 + len;
    }
    this.inboundBuffer = cursor === 0 ? buf : buf.slice(cursor);
  }

  private deliver(frame: Uint8Array | string): void {
    const target = this.options.target;
    if (target) target.tell(frame as never);
  }
}

/* ----------------------------- internals -------------------------------- */

interface NetSocket {
  on(event: 'data', cb: (chunk: Uint8Array) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  once(event: 'connect', cb: () => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  write(data: Uint8Array, cb?: (err?: Error) => void): boolean;
  end(cb?: () => void): void;
  destroy(): void;
}

interface NetModule {
  createConnection(opts: { host: string; port: number }): NetSocket;
}

const netLazy: Lazy<Promise<NetModule>> = Lazy.of(async () => {
  const name = 'node:net';
  return (await import(name)) as NetModule;
});
