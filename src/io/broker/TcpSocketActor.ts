import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import {
  DEFAULT_FRAMING,
  DEFAULT_LINE_DELIMITER,
  DEFAULT_MAX_FRAME_LENGTH,
  DEFAULT_MAX_LINE_LENGTH,
  appendChunk,
  extractLengthPrefixedFrames,
  extractLineFrames,
  readFramingFromConfig,
} from './TcpFraming.js';
import type { FrameExtraction, TcpFrame } from './TcpFraming.js';
import { TcpSocketOptionsValidator } from './TcpSocketOptions.js';
import type { TcpSocketOptions, TcpSocketOptionsType } from './TcpSocketOptions.js';

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
type SendCommand = { readonly kind: 'send'; readonly payload: TcpOutbound };

export type TcpSocketCommand = SendCommand;

export class TcpSocketActor extends BrokerActor<TcpSocketOptionsType, TcpSocketCommand, TcpOutbound> {
  private socket: NetSocket | null = null;
  /** Buffer for partial frames not yet matched by the framing strategy. */
  private inboundBuffer: Uint8Array = new Uint8Array(0);
  /**
   * How far into {@link inboundBuffer} the `lines` delimiter search already
   * reached.  Carrying it across chunks is what keeps a delimiter-free peer
   * from making every chunk re-scan everything buffered so far (#610).
   */
  private inboundScanFrom = 0;

  constructor(options: TcpSocketOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.tcp; }
  protected builtInDefaultOptions(): Partial<TcpSocketOptionsType> {
    return { framing: DEFAULT_FRAMING };
  }
  protected readOptionsFromConfig(config: Config): Partial<TcpSocketOptionsType> {
    const out: { -readonly [K in keyof TcpSocketOptionsType]?: TcpSocketOptionsType[K] } = {};
    if (config.hasPath('host')) out.host = config.getString('host');
    if (config.hasPath('port')) out.port = config.getInt('port');
    if (config.hasPath('framing')) out.framing = readFramingFromConfig(config.getConfig('framing'));
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof TcpSocketOptionsType> {
    return ['host', 'port', 'target'];
  }
  protected override optionsValidator(): TcpSocketOptionsValidator { return new TcpSocketOptionsValidator(); }
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
    // Before the early return, not after: bytes from the connection that just
    // went are meaningless to the next one, and this is the single teardown
    // path every reconnect goes through (#578).  It also has to run when the
    // socket is already gone — `dropConnection` nulls it, and the base class
    // still calls in here before the next connect attempt.
    this.resetInboundBuffer();
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

  override onReceive(command: TcpSocketCommand): void {
    match(command)
      .with({ kind: 'send' }, (c) => this.onSend(c))
      .exhaustive();
  }

  private onSend(command: SendCommand): void {
    this.enqueueOutbound(command.payload);
  }

  /* ---------------------------- framing ----------------------------- */

  private handleData(chunk: Uint8Array): void {
    this.inboundBuffer = appendChunk(this.inboundBuffer, chunk);
    const framing = this.options.framing ?? DEFAULT_FRAMING;
    if (framing.kind === 'bytes') {
      this.deliver(this.inboundBuffer);
      this.resetInboundBuffer();
    } else if (framing.kind === 'lines') {
      this.extractLines(
        framing.delimiter ?? DEFAULT_LINE_DELIMITER,
        framing.maxLineLen ?? DEFAULT_MAX_LINE_LENGTH,
      );
    } else {
      this.extractLengthPrefixed(framing.maxFrameLen ?? DEFAULT_MAX_FRAME_LENGTH);
    }
  }

  private extractLines(delimiter: string, maxLineLen: number): void {
    this.applyExtraction(
      extractLineFrames(this.inboundBuffer, delimiter, maxLineLen, this.inboundScanFrom),
    );
  }

  private extractLengthPrefixed(maxFrameLen: number): void {
    this.applyExtraction(extractLengthPrefixedFrames(this.inboundBuffer, maxFrameLen));
  }

  /**
   * Deliver what the pass completed, then either drop the connection (a cap
   * was breached) or keep the leftover for the next chunk.
   *
   * A breached cap costs the whole connection because a client actor owns
   * exactly one — the server's counterpart drops only the offending
   * connection instead.
   */
  private applyExtraction(extraction: FrameExtraction): void {
    for (const frame of extraction.frames) this.deliver(frame);
    if (extraction.overflow !== undefined) {
      this.dropConnection(new Error(extraction.overflow));
      return;
    }
    this.inboundBuffer = extraction.remainder;
    this.inboundScanFrom = extraction.scanFrom ?? 0;
  }

  /**
   * Discard what the peer sent, take the socket down, then report the loss.
   *
   * All three, because reporting alone was inert (#578): the extractors hand
   * a breached buffer back untouched for the caller to discard, and
   * `handleConnectionLost` never touches the transport — it flips the state
   * and asks the reconnect policy what to do.  With `reconnect: false`, or
   * once `maxAttempts` runs out, that policy does nothing at all, so the
   * socket stayed attached with its `'data'` listener live and the same peer
   * went on growing the buffer the cap had just refused.  Even under a
   * working policy the guard was only inert for the backoff window, and the
   * bytes survived it.
   *
   * Order matters.  Listeners go first: `destroy()` fires `'close'`, whose
   * handler calls back into `handleConnectionLost` with `socket closed`,
   * which would overwrite the real cause.  The base class' `_transportOpened`
   * flag stays set, which is correct — the next `_tryConnect` still runs
   * `disconnectImplementation`, and that is where the buffer reset lives.
   */
  private dropConnection(cause: Error): void {
    this.resetInboundBuffer();
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      sock.removeAllListeners();
      try { sock.destroy(); } catch { /* already gone */ }
    }
    this.handleConnectionLost(cause);
  }

  /** Forget every pending inbound byte and the scan position that indexes it. */
  private resetInboundBuffer(): void {
    this.inboundBuffer = new Uint8Array(0);
    this.inboundScanFrom = 0;
  }

  private deliver(frame: TcpFrame): void {
    const target = this.options.target;
    if (target) target.tell(frame as never);
  }
}

/* ----------------------------- internals -------------------------------- */

interface NetSocket {
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  once(event: 'connect', listener: () => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  write(data: Uint8Array, callback?: (err?: Error) => void): boolean;
  end(callback?: () => void): void;
  destroy(): void;
}

interface NetModule {
  createConnection(options: { host: string; port: number }): NetSocket;
}

const netLazy: Lazy<Promise<NetModule>> = Lazy.of(async () => {
  const name = 'node:net';
  return (await import(name)) as NetModule;
});
