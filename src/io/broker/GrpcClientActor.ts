import { match } from 'ts-pattern';
import { ConfigError } from '../../config/Config.js';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { RetiredLeaves } from '../../config/RetiredKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable, Scheduler } from '../../Scheduler.js';
import { DeadLetter } from '../../SystemMessages.js';
import { Lazy } from '../../util/Lazy.js';
import { randomId } from '../../util/RandomString.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { DEFAULT_GRPC_STREAM_IDLE_TIMEOUT_MS, GrpcClientOptionsValidator } from './GrpcClientOptions.js';
import type { GrpcChannelOptions, GrpcClientOptions, GrpcClientOptionsType } from './GrpcClientOptions.js';

/**
 * Inbound gRPC reply / stream frame delivered to subscribers.  The
 * `kind` discriminates between a unary completion, the handle for a
 * caller-driven stream, a stream chunk, the stream-end signal, and a
 * stream error.
 */
export type ReplyMessage = { readonly kind: 'reply'; readonly target: ActorRef<unknown>; readonly response: unknown };
export type StreamStartedMessage = {
  readonly kind: 'stream-started';
  readonly target: ActorRef<unknown>;
  readonly handle: GrpcStreamHandle;
};
export type StreamDataMessage = {
  readonly kind: 'stream-data';
  readonly target: ActorRef<unknown>;
  readonly streamId: number;
  readonly chunk: unknown;
};
export type StreamEndMessage = { readonly kind: 'stream-end'; readonly target: ActorRef<unknown>; readonly streamId: number };
export type StreamErrorMessage = {
  readonly kind: 'stream-error';
  readonly target: ActorRef<unknown>;
  readonly streamId: number;
  readonly error: Error;
};
export type RpcErrorMessage = { readonly kind: 'rpc-error'; readonly target: ActorRef<unknown>; readonly error: Error };

export type GrpcInbound =
  | ReplyMessage
  | StreamStartedMessage
  | StreamDataMessage
  | StreamEndMessage
  | StreamErrorMessage
  | RpcErrorMessage;

/**
 * Write capability for a stream the *caller* drives — the client-stream
 * and bidi classes both.
 *
 * Two fields, two jobs.  `streamId` is the correlation id: it is what
 * this stream's `stream-data` / `stream-end` / `stream-error` frames
 * carry, so one collector can multiplex several concurrent streams.
 * `token` is the capability: `clientStreamSend` / `clientStreamClose`
 * and `bidiSend` / `bidiClose` find the stream by token, never by id.
 *
 * The split matters because a `tell` carries no verified sender.  A
 * sequential id doubles as an address — knowing one hands you the next
 * — so an id alone would let anything that can reach the client actor
 * write into, or close, a stream it never opened.  Sixty-four bits of
 * `crypto.getRandomValues` cannot be guessed, which makes the map
 * lookup itself the ownership check: a wrong token simply finds
 * nothing.
 */
export type GrpcStreamHandle = {
  readonly streamId: number;
  readonly token: string;
};

/**
 * Hex characters in a {@link GrpcStreamHandle} token — 64 bits, the
 * same order of magnitude the framework uses for every other name it
 * has to keep unguessable (see `randomId`).
 */
const STREAM_TOKEN_LENGTH = 16;

/**
 * Mint a handle for stream `streamId`.
 *
 * A free function rather than a method so the entropy of the token —
 * the whole point of the handle — is assertable without a gRPC module,
 * a socket or an actor system.
 */
export function createGrpcStreamHandle(streamId: number): GrpcStreamHandle {
  return { streamId, token: randomId(STREAM_TOKEN_LENGTH) };
}

/** TLS / mTLS credentials. */
export type GrpcCredentials =
  | { readonly kind: 'insecure' }
  | { readonly kind: 'tls'; readonly rootCerts?: Uint8Array; readonly cert?: Uint8Array; readonly key?: Uint8Array };

type UnaryCommand = {
  readonly kind: 'unary';
  readonly method: string;
  readonly request: unknown;
  readonly target: ActorRef<unknown>;
};
type ServerStreamCommand = {
  readonly kind: 'serverStream';
  readonly method: string;
  readonly request: unknown;
  readonly target: ActorRef<unknown>;
};
type ClientStreamStartCommand = {
  readonly kind: 'clientStreamStart';
  readonly method: string;
  readonly target: ActorRef<unknown>;
};
type ClientStreamSendCommand = {
  readonly kind: 'clientStreamSend';
  readonly handle: GrpcStreamHandle;
  readonly chunk: unknown;
};
type ClientStreamCloseCommand = { readonly kind: 'clientStreamClose'; readonly handle: GrpcStreamHandle };
type BidiStartCommand = { readonly kind: 'bidiStart'; readonly method: string; readonly target: ActorRef<unknown> };
type BidiSendCommand = {
  readonly kind: 'bidiSend';
  readonly handle: GrpcStreamHandle;
  readonly chunk: unknown;
};
type BidiCloseCommand = { readonly kind: 'bidiClose'; readonly handle: GrpcStreamHandle };

/**
 * The four commands that address an already-open caller-driven stream by
 * handle — client-stream and bidi, send and close.
 *
 * Grouped because the handle read is the same on all four, and so is the
 * guard in front of it: they are the only commands whose first act is to
 * dereference something the *caller* supplied.
 */
type CallerStreamCommand =
  | ClientStreamSendCommand
  | ClientStreamCloseCommand
  | BidiSendCommand
  | BidiCloseCommand;

/** Outbound command — what the actor accepts to fire RPC calls. */
export type GrpcClientCommand =
  | UnaryCommand
  | ServerStreamCommand
  | ClientStreamStartCommand
  | ClientStreamSendCommand
  | ClientStreamCloseCommand
  | BidiStartCommand
  | BidiSendCommand
  | BidiCloseCommand;

type OutboundOp = {
  readonly op: GrpcClientCommand;
};

/**
 * gRPC client actor.  One client instance per service, covering all
 * four gRPC call classes — unary, server-stream, client-stream and
 * bidi-stream.  All inbound data (replies, stream chunks) goes to the
 * per-call `target` actor as `GrpcInbound` messages.
 *
 * Caller-driven streams — client-stream and bidi alike — open the same
 * way: `clientStreamStart` / `bidiStart` return nothing, and the actor
 * delivers a `'stream-started'` frame to the target carrying a
 * {@link GrpcStreamHandle}.  Subsequent `clientStreamSend` /
 * `clientStreamClose` and `bidiSend` / `bidiClose` pass that handle
 * back, and the registry each resolves against is keyed by the handle's
 * token, so the lookup *is* the ownership check.
 *
 * A client-streaming RPC answers once: its single server response
 * arrives as an ordinary `'reply'`, a failure as `'rpc-error'`.  A bidi
 * RPC answers with a stream, so its responses arrive as
 * `'stream-data'` / `'stream-end'` / `'stream-error'` frames carrying
 * the handle's `streamId`.
 *
 * Deadlines: `deadlineMs` bounds a **unary** call and nothing else.
 * A gRPC deadline covers the whole RPC, so one value cannot both fail
 * a request/response call promptly and let a long-lived stream live —
 * see `buildCallOptions`.
 */
export class GrpcClientActor
  extends BrokerActor<GrpcClientOptionsType, GrpcClientCommand, OutboundOp> {
  private serviceClient: GrpcServiceClient | null = null;
  private nextStreamId = 1;
  /*
   * Both registries are keyed by `GrpcStreamHandle.token` — the key *is* the
   * ownership check — and both entries carry the call and nothing else.
   *
   * They used to copy the opening command's `target` in beside it, which is
   * what #788's own commit body admitted when it said the entries "recorded
   * the owning target and never consulted it".  The copy was invisible rather
   * than merely unused: `stream.call` is the only read either map has, the
   * reply address a stream actually spends is the `op.target` its own
   * listeners and callbacks close over, and those are reachable *through* the
   * stored call — so the copy did not even pin an `ActorRef` the entry was not
   * already holding.
   *
   * Nor is it a placeholder for a reader that is wanted.  An owner whose
   * stream goes with the connection is told by the call's *own* terminal
   * event — `'stream-end'` / `'stream-error'` for a bidi call, the response
   * callback's `'reply'` / `'rpc-error'` for a client-streaming one — and
   * every one of those closes over `op.target` without consulting the map.
   * `disconnectImplementation` deliberately sends no frame of its own, and
   * the documented answer to a reconnect is to re-issue the call on
   * `BrokerConnected` rather than to wait for one (#1510).
   */
  /*
   * `idle` is the stream's silence deadline (#1222), read by the send paths:
   * a caller's own write is activity, so `onBidiSend` / `onClientStreamSend`
   * push it back.  `null` when the timeout is off.
   */
  private readonly bidiStreams = new Map<string, { call: GrpcDuplexCall; idle: StreamIdleWatch | null }>();
  private readonly clientStreams = new Map<string, { call: GrpcWritableCall; idle: StreamIdleWatch | null }>();
  /**
   * Every armed silence deadline, server streams and half-closed client
   * streams included — neither has a registry entry, so this is the only
   * handle {@link disconnectImplementation} has on their timers.
   */
  private readonly idleWatches = new Set<StreamIdleWatch>();

  constructor(options: GrpcClientOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.grpc.client.root; }
  protected builtInDefaultOptions(): Partial<GrpcClientOptionsType> {
    return {
      credentials: { kind: 'insecure' },
      deadlineMs: 30_000,
      streamIdleTimeoutMs: DEFAULT_GRPC_STREAM_IDLE_TIMEOUT_MS,
    };
  }
  protected readOptionsFromConfig(config: Config): Partial<GrpcClientOptionsType> {
    return readGrpcClientOptionsFromConfig(config);
  }
  protected override retiredLeaves(): RetiredLeaves { return RETIRED_GRPC_CLIENT_LEAVES; }
  protected requiredOptions(): ReadonlyArray<keyof GrpcClientOptionsType> {
    return ['protoPath', 'packageName', 'serviceName', 'endpoint'];
  }
  protected override optionsValidator(): GrpcClientOptionsValidator { return new GrpcClientOptionsValidator(); }
  protected endpointLabel(): string { return `grpc://${this.options.endpoint}`; }

  /**
   * Build the grpc-js service client for the configured proto.
   *
   * Its own hook rather than the body of `connectImplementation` so a
   * test subclass can inject a fake client: the two `@grpc/*` peer
   * dependencies are heavy and not installed for the unit suite, yet
   * everything worth asserting about this actor — what the call sites
   * hand grpc-js, and who is allowed to write into a stream — lives on
   * the far side of them.  Same seam as `JetStreamActor`'s
   * `createNatsConnection`.
   */
  protected async createServiceClient(): Promise<GrpcServiceClient> {
    const grpc = await grpcLazy.get();
    const protoLoader = await protoLoaderLazy.get();

    const protoPaths = Array.isArray(this.options.protoPath)
      ? [...this.options.protoPath]
      : [this.options.protoPath!];
    const packageDefinition = protoLoader.loadSync(protoPaths, {
      keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as Record<string, unknown>;

    // Walk the dotted package name.
    let pkg: Record<string, unknown> = loaded;
    for (const seg of this.options.packageName!.split('.')) {
      const next = pkg[seg];
      if (!next || typeof next !== 'object') {
        throw new Error(`grpc: package '${this.options.packageName}' not found in proto`);
      }
      pkg = next as Record<string, unknown>;
    }
    const ServiceConstructor = pkg[this.options.serviceName!] as GrpcServiceConstructor | undefined;
    if (!ServiceConstructor) {
      throw new Error(`grpc: service '${this.options.serviceName}' not found in package '${this.options.packageName}'`);
    }

    return this.instantiateServiceClient(ServiceConstructor, this.buildCredentials(grpc));
  }

  /**
   * Construct the proto-loaded service client.
   *
   * Split out of {@link createServiceClient} because everything above it
   * needs the two `@grpc/*` modules and this step does not: an override
   * that supplies its own constructor can call straight through, and the
   * unit suite does, which is what makes `channelOptions` reaching
   * grpc-js's third constructor slot assertable without installing the
   * peers (#790).
   *
   * That slot is the whole hardening surface: message-size caps,
   * keepalive, connection age and idle reaping are channel arguments,
   * not per-call options, so nothing this actor exposes elsewhere can
   * reach them.  `undefined` when unset is deliberate — grpc-js then
   * applies its own defaults, which is not the same as an empty object
   * on every release.
   */
  protected instantiateServiceClient(
    ServiceConstructor: GrpcServiceConstructor,
    credentials: GrpcCredentialsLike,
  ): GrpcServiceClient {
    return new ServiceConstructor(this.options.endpoint!, credentials, this.options.channelOptions);
  }

  protected async connectImplementation(): Promise<void> {
    this.serviceClient = await this.createServiceClient();
  }

  protected async disconnectImplementation(): Promise<void> {
    for (const watch of this.idleWatches) watch.stop();
    this.idleWatches.clear();
    for (const [, stream] of this.bidiStreams) {
      try { stream.call.end(); } catch { /* ignore */ }
    }
    this.bidiStreams.clear();
    for (const [, stream] of this.clientStreams) {
      try { stream.call.end(); } catch { /* ignore */ }
    }
    this.clientStreams.clear();
    if (this.serviceClient) {
      try { this.serviceClient.close?.(); } catch { /* ignore */ }
      this.serviceClient = null;
    }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<OutboundOp>): Promise<void> {
    if (!this.serviceClient) throw new Error('GrpcClientActor: not connected');
    // The real command dispatcher: `onCommand` only enqueues, so every
    // GrpcClientCommand variant is handled here.
    match(env.payload.op)
      .with({ kind: 'unary' }, (c) => this.onUnary(c))
      .with({ kind: 'serverStream' }, (c) => this.onServerStream(c))
      .with({ kind: 'clientStreamStart' }, (c) => this.onClientStreamStart(c))
      .with({ kind: 'clientStreamSend' }, (c) => this.onClientStreamSend(c))
      .with({ kind: 'clientStreamClose' }, (c) => this.onClientStreamClose(c))
      .with({ kind: 'bidiStart' }, (c) => this.onBidiStart(c))
      .with({ kind: 'bidiSend' }, (c) => this.onBidiSend(c))
      .with({ kind: 'bidiClose' }, (c) => this.onBidiClose(c))
      .exhaustive();
  }

  /*
   * The four send/close paths answer two different failures two
   * different ways, and the distinction is the point.
   *
   * A **well-formed handle naming an unknown stream** — a stale id, a
   * token the registry no longer holds — is a silent no-op: the stream
   * is already gone (the server closed it, or the connection dropped and
   * cleared the map), the caller has been told via 'stream-end' /
   * 'stream-error' / 'reply', and the race between that notice and a
   * write already in flight happens in correct use.
   *
   * A **command carrying no usable handle at all** is not that.  Nothing
   * `createGrpcStreamHandle` mints can look like it, so it is a caller
   * defect, and it becomes a `DeadLetter` — see
   * {@link resolveStreamToken}.  What neither is, any more, is a thrown
   * `TypeError`.
   */

  /**
   * Token naming the stream a caller-driven send/close addresses, or
   * `null` when the command carries none.
   *
   * `handle` is declared non-optional and is read here as if it were not,
   * because the declaration is the only thing that ever guaranteed it and
   * a declaration is not a runtime check.  Every message into this actor
   * arrives through `tell`, which callers reach across an `as never`
   * cast, so a JavaScript caller, a deserialised message and a stale
   * handle arriving as `null` all reach this read.
   *
   * Before the guard the bare `command.handle.token` threw inside
   * `dispatchOutgoing`, and `BrokerActor._dispatchOne` reads *any* throw
   * from there as a dropped connection: it unshifts the offending
   * envelope back at the head of the outbound buffer and calls
   * `handleConnectionLost`, after which `_drainBuffer` re-dispatches the
   * very same envelope on every reconnect.  One malformed `tell` was
   * therefore an unbounded reconnect loop — measured at 17 service-client
   * constructions in three seconds — with every legitimate write stuck
   * behind the poisoned head.  Keying the registry on the token (#788,
   * #1040) is what made that reachable: the id-keyed lookup it replaced
   * never dereferenced anything.
   *
   * The answer is a dead letter rather than silence because the two
   * failures above must not be indistinguishable, and rather than a bare
   * `log.warn` because `deadLetters` is the framework's existing channel
   * for a message that went nowhere: it is observable programmatically
   * (event stream, `DeadLetterQueue`), it is throttled, and it keeps the
   * payload out of the log line — which a hand-rolled warning about a
   * caller-supplied command would not.
   */
  private resolveStreamToken(command: CallerStreamCommand): string | null {
    const token: unknown = (command.handle as GrpcStreamHandle | undefined)?.token;
    if (typeof token === 'string') return token;
    this.system.deadLetters.tell(new DeadLetter(command, null, this.self));
    return null;
  }

  private onBidiSend(command: BidiSendCommand): void {
    const token = this.resolveStreamToken(command);
    if (token === null) return;
    const stream = this.bidiStreams.get(token);
    if (!stream) return;
    stream.idle?.touch();
    stream.call.write(command.chunk);
  }

  private onBidiClose(command: BidiCloseCommand): void {
    const token = this.resolveStreamToken(command);
    if (token === null) return;
    const stream = this.bidiStreams.get(token);
    if (stream) {
      try { stream.call.end(); } catch { /* ignore */ }
      this.bidiStreams.delete(token);
    }
  }

  private onClientStreamSend(command: ClientStreamSendCommand): void {
    const token = this.resolveStreamToken(command);
    if (token === null) return;
    const stream = this.clientStreams.get(token);
    if (!stream) return;
    stream.idle?.touch();
    stream.call.write(command.chunk);
  }

  /**
   * Half-close: the request stream ends, the response is still to come.
   * The entry is dropped here rather than when the response arrives, so
   * a `clientStreamSend` that races the close cannot turn into a
   * write-after-end (which grpc-js throws on).  The reply still reaches
   * the caller — the response callback closes over its `target`, it
   * does not look the stream back up.  The silence deadline stays armed
   * until that reply, so a server that never answers is still reaped.
   */
  private onClientStreamClose(command: ClientStreamCloseCommand): void {
    const token = this.resolveStreamToken(command);
    if (token === null) return;
    const stream = this.clientStreams.get(token);
    if (stream) {
      stream.idle?.touch();
      try { stream.call.end(); } catch { /* ignore */ }
      this.clientStreams.delete(token);
    }
  }

  protected override onCommand(command: GrpcClientCommand): void {
    this.enqueueOutbound({ op: command });
  }

  /* ----------------------------- internals ----------------------------- */

  /**
   * Per-call options for grpc-js, carrying the configured deadline.
   *
   * Minted per call because a gRPC deadline is an absolute instant, not
   * a duration: `deadlineMs` counts from *this* call's start, so a
   * cached options object would hand every later call an already
   * expired one.
   *
   * Deliberately used by `onUnary` alone.  A deadline bounds the whole
   * RPC, streams included, so applying the same value to the three
   * streaming classes would tear down every stream that outlives it —
   * and a long-lived stream is a documented, supported pattern here.
   * `deadlineMs` is one knob: a value generous enough for an hour-long
   * bidi stream is useless on a unary call, and a value right for a
   * unary call kills the stream.  A stream whose peer has gone quiet is
   * bounded by silence instead — `streamIdleTimeoutMs`, see
   * {@link watchStreamIdle} — and a peer that has died outright by the
   * HTTP/2 keepalive in `channelOptions` (see {@link GrpcChannelOptions}).
   */
  private buildCallOptions(): GrpcCallOptions {
    const deadlineMs = this.options.deadlineMs;
    if (deadlineMs === undefined) return {};
    return { deadline: new Date(Date.now() + deadlineMs) };
  }

  private onUnary(op: UnaryCommand): void {
    const client = this.serviceClient;
    if (!client) return;
    const invoke = (client as unknown as Record<string, GrpcUnaryFunction>)[op.method];
    if (!invoke) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    invoke.call(client, op.request, this.buildCallOptions(), (err, response) => {
      if (err) op.target.tell({ kind: 'rpc-error', target: op.target, error: err } as never);
      else op.target.tell({ kind: 'reply', target: op.target, response } as never);
    });
  }

  private onServerStream(op: ServerStreamCommand): void {
    const client = this.serviceClient;
    if (!client) return;
    const invoke = (client as unknown as Record<string, GrpcServerStreamFunction>)[op.method];
    if (!invoke) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    const streamId = this.nextStreamId++;
    const call = invoke.call(client, op.request);
    // `finished` makes the idle reap the stream's one terminal frame: grpc-js
    // answers the cancel with an error of its own, and the target has already
    // been told why.
    let finished = false;
    const idle = this.watchStreamIdle((error) => {
      finished = true;
      try { call.cancel(); } catch { /* ignore */ }
      op.target.tell({ kind: 'stream-error', target: op.target, streamId, error } as never);
    });
    call.on('data', (chunk: unknown) => {
      if (finished) return;
      idle?.touch();
      op.target.tell({ kind: 'stream-data', target: op.target, streamId, chunk } as never);
    });
    call.on('end', () => {
      if (finished) return;
      finished = true;
      this.stopStreamIdle(idle);
      op.target.tell({ kind: 'stream-end', target: op.target, streamId } as never);
    });
    call.on('error', (err: Error) => {
      if (finished) return;
      finished = true;
      this.stopStreamIdle(idle);
      op.target.tell({ kind: 'stream-error', target: op.target, streamId, error: err } as never);
    });
  }

  /**
   * Open a client-streaming call.
   *
   * grpc-js hands back a writable call and answers through the
   * callback, so the whole RPC is one `reply` (or one `rpc-error`) —
   * no new inbound frame is needed for the response itself, only for
   * the handle that lets the caller keep writing.
   */
  private onClientStreamStart(op: ClientStreamStartCommand): void {
    const client = this.serviceClient;
    if (!client) return;
    const invoke = (client as unknown as Record<string, GrpcClientStreamFunction>)[op.method];
    if (!invoke) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    const handle = createGrpcStreamHandle(this.nextStreamId++);
    // `settled` guards the one ordering the map cannot express: a call
    // that answers synchronously would be deleted before it is added,
    // leaving a finished stream registered forever.  It also makes the
    // idle reap the call's one answer — grpc-js reports its own cancel
    // through this same callback.
    let settled = false;
    let idle: StreamIdleWatch | null = null;
    const call = invoke.call(client, (err, response) => {
      if (settled) return;
      settled = true;
      this.stopStreamIdle(idle);
      this.clientStreams.delete(handle.token);
      if (err) op.target.tell({ kind: 'rpc-error', target: op.target, error: err } as never);
      else op.target.tell({ kind: 'reply', target: op.target, response } as never);
    });
    if (!settled) {
      idle = this.watchStreamIdle((error) => {
        settled = true;
        this.clientStreams.delete(handle.token);
        try { call.cancel(); } catch { /* ignore */ }
        op.target.tell({ kind: 'rpc-error', target: op.target, error } as never);
      });
      this.clientStreams.set(handle.token, { call, idle });
    }
    op.target.tell({ kind: 'stream-started', target: op.target, handle } as never);
  }

  /**
   * Open a bidirectional call.
   *
   * The handshake is deliberately *out of band*.  It used to ride in as
   * an ordinary `'stream-data'` frame whose chunk was `{ __streamId }`,
   * which put the framework's own handshake on the same envelope as
   * server payload: `__streamId` is a legal protobuf field name, so a
   * server message carrying one was indistinguishable from the
   * handshake, and the id it named addressed *any* of this client's
   * streams.  A dedicated `'stream-started'` frame cannot be forged by
   * a server chunk, and the token on the handle it carries is what the
   * send/close registry is keyed by — so a stolen or guessed id buys
   * nothing (#788).
   *
   * `streamId` still rides on every `'stream-data'` / `'stream-end'` /
   * `'stream-error'` frame: it is the correlation id one collector
   * multiplexes on, and it is not a capability.
   */
  private onBidiStart(op: BidiStartCommand): void {
    const client = this.serviceClient;
    if (!client) return;
    const invoke = (client as unknown as Record<string, GrpcBidiFunction>)[op.method];
    if (!invoke) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    const handle = createGrpcStreamHandle(this.nextStreamId++);
    const streamId = handle.streamId;
    const call = invoke.call(client);
    let finished = false;
    const idle = this.watchStreamIdle((error) => {
      finished = true;
      this.bidiStreams.delete(handle.token);
      try { call.cancel(); } catch { /* ignore */ }
      op.target.tell({ kind: 'stream-error', target: op.target, streamId, error } as never);
    });
    this.bidiStreams.set(handle.token, { call, idle });
    call.on('data', (chunk: unknown) => {
      if (finished) return;
      idle?.touch();
      op.target.tell({ kind: 'stream-data', target: op.target, streamId, chunk } as never);
    });
    call.on('end', () => {
      if (finished) return;
      finished = true;
      this.stopStreamIdle(idle);
      op.target.tell({ kind: 'stream-end', target: op.target, streamId } as never);
      this.bidiStreams.delete(handle.token);
    });
    call.on('error', (err: Error) => {
      if (finished) return;
      finished = true;
      this.stopStreamIdle(idle);
      op.target.tell({ kind: 'stream-error', target: op.target, streamId, error: err } as never);
      this.bidiStreams.delete(handle.token);
    });
    op.target.tell({ kind: 'stream-started', target: op.target, handle } as never);
  }

  /**
   * Arm a stream's silence deadline, or return `null` when
   * `streamIdleTimeoutMs` is `0`.  `onIdle` runs once, with the error the
   * target is told, after the watch has already taken itself out of
   * {@link idleWatches}.
   */
  private watchStreamIdle(onIdle: (error: Error) => void): StreamIdleWatch | null {
    const timeoutMs = this.options.streamIdleTimeoutMs ?? 0;
    if (timeoutMs <= 0) return null;
    const watch: StreamIdleWatch = new StreamIdleWatch(this.system.scheduler, timeoutMs, () => {
      this.idleWatches.delete(watch);
      onIdle(new Error(
        `grpc stream to ${this.redactedEndpointLabel()} carried nothing for ${timeoutMs} ms `
        + '(stream idle timeout); cancelled',
      ));
    });
    this.idleWatches.add(watch);
    return watch;
  }

  private stopStreamIdle(watch: StreamIdleWatch | null): void {
    if (watch === null) return;
    watch.stop();
    this.idleWatches.delete(watch);
  }

  private buildCredentials(grpc: GrpcModule): GrpcCredentialsLike {
    const credentials = this.options.credentials ?? { kind: 'insecure' };
    if (credentials.kind === 'insecure') return grpc.credentials.createInsecure();
    return grpc.credentials.createSsl(
      credentials.rootCerts ? Buffer.from(credentials.rootCerts) : null,
      credentials.key ? Buffer.from(credentials.key) : null,
      credentials.cert ? Buffer.from(credentials.cert) : null,
    );
  }
}

/* -------------------------- stream idle deadline ------------------------ */

/**
 * One stream's silence deadline (#1222).
 *
 * The same shape as `BrokerActor`'s read-idle deadline: {@link touch} is a
 * field write and nothing else, because it runs once per frame, and the timer
 * reads the timestamp when it fires and re-arms for the remainder if the
 * stream turned out to be busy — so a talking stream costs one wake-up per
 * timeout, whatever its throughput.  Time comes from the scheduler that arms
 * the timer, so a `ManualScheduler` drives both halves.
 */
class StreamIdleWatch {
  private lastActivityAt: number;
  private handle: Cancellable | null = null;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
  ) {
    this.lastActivityAt = scheduler.now();
    this.arm(timeoutMs);
  }

  touch(): void { this.lastActivityAt = this.scheduler.now(); }

  /** Disarm.  A cancelled one-shot never runs, so nothing past this fires. */
  stop(): void {
    this.handle?.cancel();
    this.handle = null;
  }

  private arm(delayMs: number): void {
    this.handle = this.scheduler.scheduleOnceFunction(delayMs, () => this.onDeadline());
  }

  private onDeadline(): void {
    this.handle = null;
    const quietForMs = this.scheduler.now() - this.lastActivityAt;
    if (quietForMs < this.timeoutMs) {
      this.arm(this.timeoutMs - quietForMs);
      return;
    }
    this.onIdle();
  }
}

/* ----------------------------- HOCON reader ----------------------------- */

/**
 * The camelCase spellings the gRPC client's own leaves had before #1443,
 * mapped to the leaves that replaced them — see `BrokerActor.retiredLeaves`.
 */
const RETIRED_GRPC_CLIENT_LEAVES: RetiredLeaves = {
  protoPath: 'proto-path',
  packageName: 'package-name',
  serviceName: 'service-name',
  deadlineMs: 'deadline',
};

/**
 * Read the `actor-ts.io.broker.grpc.client` block's own leaves off the system
 * config, at the full paths `keys` holds; the reconnect / breaker / buffer
 * leaves are `BrokerActor`'s.  An unset leaf is omitted.  `deadline` and
 * `stream-idle-timeout` are durations, so `2s` and a bare millisecond count
 * read alike, and `stream-idle-timeout = 0` turns the timeout off.  `credentials`
 * is certificate material and `channelOptions` grpc-js's own keys, so
 * neither has a leaf.
 */
export function readGrpcClientOptionsFromConfig(
  config: Config,
  keys: typeof ConfigKeys.io.broker.grpc.client = ConfigKeys.io.broker.grpc.client,
): Partial<GrpcClientOptionsType> {
  const out: { -readonly [K in keyof GrpcClientOptionsType]?: GrpcClientOptionsType[K] } = {};
  if (config.hasPath(keys.protoPath)) out.protoPath = readProtoPath(config, keys.protoPath);
  if (config.hasPath(keys.packageName)) out.packageName = config.getString(keys.packageName);
  if (config.hasPath(keys.serviceName)) out.serviceName = config.getString(keys.serviceName);
  if (config.hasPath(keys.endpoint)) out.endpoint = config.getString(keys.endpoint);
  if (config.hasPath(keys.deadline)) out.deadlineMs = config.getDuration(keys.deadline);
  if (config.hasPath(keys.streamIdleTimeout)) out.streamIdleTimeoutMs = config.getDuration(keys.streamIdleTimeout);
  return out;
}

/**
 * Read `proto-path`: one file as a string, or several as a list, and a
 * one-element list as the string it holds.  HOCON offers no accessor that
 * says which of the two it was given, so the list is asked for first and a
 * single path is what a refusal leaves — the string form is the one the docs
 * show, and reading only lists refused it.
 */
function readProtoPath(config: Config, path: string): string | ReadonlyArray<string> {
  let paths: string[];
  try {
    paths = config.getStringList(path);
  } catch (e) {
    if (e instanceof ConfigError) return config.getString(path);
    throw e;
  }
  return paths.length === 1 ? paths[0]! : paths;
}

/* --------------------------- shared internals -------------------------- */

/*
 * The structural shims below are exported for the same reason the
 * server side exports `GrpcServerUnaryRequest` & co.: they are the
 * whole contract a `createServiceClient` override has to satisfy, so a
 * fake client can be written — in this repo's unit suite or in a
 * user's — without `@grpc/grpc-js` installed.  They describe grpc-js's
 * shape, they are not a re-declaration of its API.
 */

export interface GrpcServiceConstructor {
  new (
    endpoint: string,
    credentials: GrpcCredentialsLike,
    channelOptions?: GrpcChannelOptions,
  ): GrpcServiceClient;
}

export interface GrpcServiceClient {
  close?(): void;
  [method: string]: unknown;
}

/**
 * Per-call options, the slot after the request.
 *
 * grpc-js parses `method(request, [metadata], [options], callback)`
 * positionally *and* by type — an object that is not a `Metadata`
 * instance is read as the options — which is why a bare data shape
 * carrying only what this actor sets is enough.
 */
export type GrpcCallOptions = {
  /** Absolute instant the call must complete by; grpc-js fails it with `DEADLINE_EXCEEDED`. */
  readonly deadline?: Date;
};

export interface GrpcUnaryFunction {
  call(client: GrpcServiceClient, request: unknown, options: GrpcCallOptions,
       callback: (err: Error | null, response: unknown) => void): void;
}

/**
 * grpc-js `ClientReadableStream` — a server-streaming call is
 * read-only.  Named for the direction, not the call class, so it does
 * not collide with the server actor's `GrpcServerStreamCall`.
 */
export interface GrpcReadableCall {
  on(event: 'data', listener: (chunk: unknown) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  /**
   * Abandon the call — grpc-js's `call.cancel()`.  The silence deadline
   * (`streamIdleTimeoutMs`) is what calls it, on all three stream shims
   * (#1222).
   */
  cancel(): void;
}

export interface GrpcServerStreamFunction {
  call(client: GrpcServiceClient, request: unknown): GrpcReadableCall;
}

/** grpc-js `ClientWritableStream` — a client-streaming call is write-only. */
export interface GrpcWritableCall {
  write(chunk: unknown): void;
  end(): void;
  /** Abandon the call — see {@link GrpcReadableCall.cancel}. */
  cancel(): void;
}

export interface GrpcClientStreamFunction {
  call(client: GrpcServiceClient,
       callback: (err: Error | null, response: unknown) => void): GrpcWritableCall;
}

export interface GrpcDuplexCall {
  on(event: 'data', listener: (chunk: unknown) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  write(chunk: unknown): void;
  end(): void;
  /** Abandon the call — see {@link GrpcReadableCall.cancel}. */
  cancel(): void;
}

export interface GrpcBidiFunction {
  call(client: GrpcServiceClient): GrpcDuplexCall;
}

export type GrpcCredentialsLike = { /* opaque token, set by grpc.credentials.* */ };

interface GrpcModule {
  loadPackageDefinition(def: unknown): unknown;
  credentials: {
    createInsecure(): GrpcCredentialsLike;
    createSsl(
      rootCerts: Buffer | null, privateKey: Buffer | null, certChain: Buffer | null,
    ): GrpcCredentialsLike;
  };
}

interface ProtoLoaderModule {
  loadSync(filename: string | string[], options?: object): unknown;
}

const grpcLazy: Lazy<Promise<GrpcModule>> = Lazy.of(async () => {
  try {
    const name = '@grpc/grpc-js';
    return (await import(name)) as unknown as GrpcModule;
  } catch (e) {
    throw new Error(
      'GrpcClientActor requires "@grpc/grpc-js".  Install it with: npm install @grpc/grpc-js @grpc/proto-loader\n'
      + 'Original error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});

const protoLoaderLazy: Lazy<Promise<ProtoLoaderModule>> = Lazy.of(async () => {
  try {
    const name = '@grpc/proto-loader';
    return (await import(name)) as unknown as ProtoLoaderModule;
  } catch (e) {
    throw new Error(
      'GrpcClientActor requires "@grpc/proto-loader".  Install it with: npm install @grpc/proto-loader\n'
      + 'Original error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});
