import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { DEFAULT_FRAMING, readFramingFromConfig } from './TcpFraming.js';
import type { TcpFrame } from './TcpFraming.js';
import { TcpInboundBuffer } from './TcpInboundBuffer.js';
import { DEFAULT_TCP_KEEP_ALIVE_MS, TcpSocketOptionsValidator } from './TcpSocketOptions.js';
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
  /**
   * Partial frames not yet matched by the framing strategy.  The buffer owns
   * the accumulation as well as the bytes: appending by re-allocating, and
   * re-scanning from 0, are both what made a delimiter-free peer quadratic
   * (#610).
   */
  private readonly inbound = new TcpInboundBuffer();
  /**
   * Rejects the connect attempt currently in flight, or `null` when none is.
   * Set for the whole window in which `connectImplementation`'s promise is
   * unsettled — see {@link abortConnectAttempt}.
   */
  private connectAbort: ((cause: Error) => void) | null = null;

  constructor(options: TcpSocketOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.tcp; }
  protected builtInDefaultOptions(): Partial<TcpSocketOptionsType> {
    return { framing: DEFAULT_FRAMING, keepAliveMs: DEFAULT_TCP_KEEP_ALIVE_MS };
  }
  protected readOptionsFromConfig(config: Config): Partial<TcpSocketOptionsType> {
    const out: { -readonly [K in keyof TcpSocketOptionsType]?: TcpSocketOptionsType[K] } = {};
    if (config.hasPath('host')) out.host = config.getString('host');
    if (config.hasPath('port')) out.port = config.getInt('port');
    if (config.hasPath('framing')) out.framing = readFramingFromConfig(config.getConfig('framing'));
    if (config.hasPath('idleTimeoutMs')) out.idleTimeoutMs = config.getDuration('idleTimeoutMs');
    if (config.hasPath('connectTimeoutMs')) out.connectTimeoutMs = config.getDuration('connectTimeoutMs');
    if (config.hasPath('keepAliveMs')) out.keepAliveMs = config.getDuration('keepAliveMs');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof TcpSocketOptionsType> {
    return ['host', 'port', 'target'];
  }
  protected override optionsValidator(): TcpSocketOptionsValidator { return new TcpSocketOptionsValidator(); }
  protected endpointLabel(): string { return `tcp://${this.options.host}:${this.options.port}`; }

  protected override idleTimeoutMs(): number | undefined { return this.options.idleTimeoutMs; }
  protected override connectTimeoutMs(): number | undefined { return this.options.connectTimeoutMs; }

  /**
   * An idle peer is abandoned the same way a peer that breached a framing cap
   * is: the socket is still open here — that is the whole point — so reporting
   * the loss without destroying it would leave a live `'data'` listener
   * attached for the backoff window, and for good under `reconnect: false`.
   * That is the inert-guard failure #578 fixed for the cap path.
   */
  protected override handleIdleTimeout(cause: Error): void {
    this.dropConnection(cause);
  }

  /**
   * Fail the in-flight connect the base class has given up on.
   *
   * The socket is destroyed *and* the promise rejected here rather than
   * leaving `destroy()` to fire `'close'`: the connect phase only listens for
   * `'connect'` and `'error'`, and a `destroy()` with no error argument emits
   * neither on every runtime.  Rejecting directly is the deterministic half.
   */
  protected override abortConnectAttempt(cause: Error): void {
    this.connectAbort?.(cause);
  }

  protected async connectImplementation(): Promise<void> {
    const net = await netLazy.get();
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.options.host!, port: this.options.port! });
      let done = false;
      this.connectAbort = (cause: Error): void => {
        if (done) return;
        done = true;
        this.connectAbort = null;
        sock.removeAllListeners();
        try { sock.destroy(); } catch { /* already gone */ }
        reject(cause);
      };
      sock.once('connect', () => {
        if (done) return;
        done = true;
        this.connectAbort = null;
        sock.removeAllListeners('error');
        this.socket = sock;
        // Before the listeners, so a probe failure has somewhere to land: the
        // OS reports an unanswered keepalive as a socket error, which is what
        // turns a peer that vanished without FIN/RST into a reconnect (#753).
        this.applyKeepAlive(sock);
        sock.on('data', (chunk: Uint8Array) => this.handleData(chunk));
        sock.on('close', () => this.handleConnectionLost(new Error('socket closed')));
        sock.on('error', (e: Error) => this.handleConnectionLost(e));
        resolve();
      });
      sock.once('error', (e: Error) => {
        if (done) return;
        done = true;
        this.connectAbort = null;
        reject(e);
      });
    });
  }

  /**
   * Turn OS keepalive on for the freshly connected socket, unless it was
   * configured away with `keepAliveMs: 0`.
   *
   * Failure is a warning rather than a connect failure: keepalive is a
   * hardening measure on a connection that already works, and a runtime whose
   * `node:net` shim does not implement it would otherwise cost every TCP
   * actor its connection.  It is not swallowed either — a silently absent
   * keepalive is the failure mode this whole change exists to remove.
   */
  private applyKeepAlive(sock: NetSocket): void {
    const keepAliveMs = this.options.keepAliveMs ?? DEFAULT_TCP_KEEP_ALIVE_MS;
    if (keepAliveMs <= 0) return;
    try { sock.setKeepAlive(true, keepAliveMs); }
    catch (e) {
      this.log.warn(
        `TcpSocketActor: could not enable TCP keepalive on ${this.redactedEndpointLabel()}: `
        + `${(e as Error).message}`,
      );
    }
  }

  protected async disconnectImplementation(): Promise<void> {
    // Before the early return, not after: bytes from the connection that just
    // went are meaningless to the next one, and this is the single teardown
    // path every reconnect goes through (#578).  It also has to run when the
    // socket is already gone — `dropConnection` nulls it, and the base class
    // still calls in here before the next connect attempt.
    this.inbound.clear();
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

  protected override onCommand(command: TcpSocketCommand): void {
    match(command)
      .with({ kind: 'send' }, (c) => this.onSend(c))
      .exhaustive();
  }

  private onSend(command: SendCommand): void {
    this.enqueueOutbound(command.payload);
  }

  /* ---------------------------- framing ----------------------------- */

  /**
   * Buffer the chunk, deliver what it completed, and drop the connection if a
   * cap was breached.
   *
   * A breached cap costs the whole connection because a client actor owns
   * exactly one — the server's counterpart drops only the offending
   * connection instead.
   */
  private handleData(chunk: Uint8Array): void {
    // Before the framing, and before the cap check below: bytes that turn out
    // to be unframeable still prove the peer is there, and the read-idle
    // deadline is a liveness question, not a validity one.
    this.noteInboundActivity();
    const extraction = this.inbound.push(chunk, this.options.framing ?? DEFAULT_FRAMING);
    for (const frame of extraction.frames) this.deliver(frame);
    if (extraction.overflow !== undefined) this.dropConnection(new Error(extraction.overflow));
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
    this.inbound.clear();
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      sock.removeAllListeners();
      try { sock.destroy(); } catch { /* already gone */ }
    }
    this.handleConnectionLost(cause);
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
  /**
   * Declared required, not optional: `node:net`'s `Socket` has carried it on
   * every supported runtime for as long as the module has existed, and an
   * optional `setKeepAlive?.()` is precisely the shape that lets a keepalive
   * go missing without anyone noticing (#751 is that bug, one interface over).
   * The call site catches instead, so an absence is a logged warning on a
   * working connection rather than a silent no-op.
   */
  setKeepAlive(enable: boolean, initialDelayMs: number): void;
}

interface NetModule {
  createConnection(options: { host: string; port: number }): NetSocket;
}

const netLazy: Lazy<Promise<NetModule>> = Lazy.of(async () => {
  const name = 'node:net';
  return (await import(name)) as NetModule;
});
