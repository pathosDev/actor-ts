import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { randomId } from '../../util/RandomString.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { GrpcClientOptionsValidator } from './GrpcClientOptions.js';
import type { GrpcClientOptions, GrpcClientOptionsType } from './GrpcClientOptions.js';

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
 * Write capability for a stream the *caller* drives.
 *
 * Two fields, two jobs.  `streamId` is the correlation id: it is what
 * this stream's `stream-data` / `stream-end` / `stream-error` frames
 * carry, so one collector can multiplex several concurrent streams.
 * `token` is the capability: `clientStreamSend` / `clientStreamClose`
 * find the stream by token, never by id.
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
type BidiSendCommand = { readonly kind: 'bidiSend'; readonly streamId: number; readonly chunk: unknown };
type BidiCloseCommand = { readonly kind: 'bidiClose'; readonly streamId: number };

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
 * Client streams: `clientStreamStart` returns nothing — the actor
 * delivers a `'stream-started'` frame to the target carrying a
 * {@link GrpcStreamHandle}.  Subsequent `clientStreamSend` /
 * `clientStreamClose` pass that handle back.  The single server
 * response arrives as an ordinary `'reply'`, which is what a
 * client-streaming RPC returns; a failure arrives as `'rpc-error'`.
 *
 * Bidi streams still use the older in-band handshake: `bidiStart`
 * publishes a `'stream-data'` frame whose chunk is `{ __streamId }`,
 * and `bidiSend` / `bidiClose` address that bare number.  That
 * handshake is a known defect — the id is guessable and the lookup has
 * no ownership check — tracked as #788; the two primitives the client
 * stream introduces (a dedicated `'stream-started'` frame and a
 * capability handle) are what it should adopt.
 */
export class GrpcClientActor
  extends BrokerActor<GrpcClientOptionsType, GrpcClientCommand, OutboundOp> {
  private serviceClient: GrpcServiceClient | null = null;
  private nextStreamId = 1;
  private readonly bidiStreams = new Map<number, { call: GrpcDuplexCall; target: ActorRef<unknown> }>();
  /** Keyed by `GrpcStreamHandle.token` — the key *is* the ownership check. */
  private readonly clientStreams = new Map<string, { call: GrpcWritableCall; target: ActorRef<unknown> }>();

  constructor(options: GrpcClientOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.grpc.client; }
  protected builtInDefaultOptions(): Partial<GrpcClientOptionsType> {
    return { credentials: { kind: 'insecure' }, deadlineMs: 30_000 };
  }
  protected readOptionsFromConfig(config: Config): Partial<GrpcClientOptionsType> {
    const out: { -readonly [K in keyof GrpcClientOptionsType]?: GrpcClientOptionsType[K] } = {};
    if (config.hasPath('protoPath')) {
      const protoPathList = config.getList('protoPath');
      if (protoPathList.length === 1 && typeof protoPathList[0] === 'string') out.protoPath = protoPathList[0];
      else out.protoPath = config.getStringList('protoPath');
    }
    if (config.hasPath('packageName')) out.packageName = config.getString('packageName');
    if (config.hasPath('serviceName')) out.serviceName = config.getString('serviceName');
    if (config.hasPath('endpoint')) out.endpoint = config.getString('endpoint');
    if (config.hasPath('deadlineMs')) out.deadlineMs = config.getDuration('deadlineMs');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof GrpcClientOptionsType> {
    return ['protoPath', 'packageName', 'serviceName', 'endpoint'];
  }
  protected override optionsValidator(): GrpcClientOptionsValidator { return new GrpcClientOptionsValidator(); }
  protected endpointLabel(): string { return `grpc://${this.options.endpoint}`; }

  protected async connectImplementation(): Promise<void> {
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

    const creds = this.buildCredentials(grpc);
    this.serviceClient = new ServiceConstructor(this.options.endpoint!, creds);
  }

  protected async disconnectImplementation(): Promise<void> {
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
    // The real command dispatcher: `onReceive` only enqueues, so every
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
   * An unknown stream — a stale id, an unknown token — is a no-op on
   * every one of these paths: the stream is already gone (the server
   * closed it, or the connection dropped and cleared the map), and the
   * caller has been told via 'stream-end' / 'stream-error' / 'reply'.
   */

  private onBidiSend(command: BidiSendCommand): void {
    const stream = this.bidiStreams.get(command.streamId);
    if (stream) stream.call.write(command.chunk);
  }

  private onBidiClose(command: BidiCloseCommand): void {
    const stream = this.bidiStreams.get(command.streamId);
    if (stream) {
      try { stream.call.end(); } catch { /* ignore */ }
      this.bidiStreams.delete(command.streamId);
    }
  }

  private onClientStreamSend(command: ClientStreamSendCommand): void {
    const stream = this.clientStreams.get(command.handle.token);
    if (stream) stream.call.write(command.chunk);
  }

  /**
   * Half-close: the request stream ends, the response is still to come.
   * The entry is dropped here rather than when the response arrives, so
   * a `clientStreamSend` that races the close cannot turn into a
   * write-after-end (which grpc-js throws on).  The reply still reaches
   * the caller — the response callback closes over its `target`, it
   * does not look the stream back up.
   */
  private onClientStreamClose(command: ClientStreamCloseCommand): void {
    const stream = this.clientStreams.get(command.handle.token);
    if (stream) {
      try { stream.call.end(); } catch { /* ignore */ }
      this.clientStreams.delete(command.handle.token);
    }
  }

  override onReceive(command: GrpcClientCommand): void {
    this.enqueueOutbound({ op: command });
  }

  /* ----------------------------- internals ----------------------------- */

  private onUnary(op: UnaryCommand): void {
    const client = this.serviceClient;
    if (!client) return;
    const invoke = (client as unknown as Record<string, GrpcUnaryFunction>)[op.method];
    if (!invoke) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    invoke.call(client, op.request, (err, response) => {
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
    call.on('data', (chunk: unknown) => {
      op.target.tell({ kind: 'stream-data', target: op.target, streamId, chunk } as never);
    });
    call.on('end', () => {
      op.target.tell({ kind: 'stream-end', target: op.target, streamId } as never);
    });
    call.on('error', (err: Error) => {
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
    // leaving a finished stream registered forever.
    let settled = false;
    const call = invoke.call(client, (err, response) => {
      settled = true;
      this.clientStreams.delete(handle.token);
      if (err) op.target.tell({ kind: 'rpc-error', target: op.target, error: err } as never);
      else op.target.tell({ kind: 'reply', target: op.target, response } as never);
    });
    if (!settled) this.clientStreams.set(handle.token, { call, target: op.target });
    op.target.tell({ kind: 'stream-started', target: op.target, handle } as never);
  }

  private onBidiStart(op: BidiStartCommand): void {
    const client = this.serviceClient;
    if (!client) return;
    const invoke = (client as unknown as Record<string, GrpcBidiFunction>)[op.method];
    if (!invoke) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    const streamId = this.nextStreamId++;
    const call = invoke.call(client);
    this.bidiStreams.set(streamId, { call, target: op.target });
    call.on('data', (chunk: unknown) => {
      op.target.tell({ kind: 'stream-data', target: op.target, streamId, chunk } as never);
    });
    call.on('end', () => {
      op.target.tell({ kind: 'stream-end', target: op.target, streamId } as never);
      this.bidiStreams.delete(streamId);
    });
    call.on('error', (err: Error) => {
      op.target.tell({ kind: 'stream-error', target: op.target, streamId, error: err } as never);
      this.bidiStreams.delete(streamId);
    });
    // Send the streamId back so the caller can address future bidiSend/Close.
    op.target.tell({ kind: 'stream-data', target: op.target, streamId, chunk: { __streamId: streamId } } as never);
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

/* --------------------------- shared internals -------------------------- */

interface GrpcServiceConstructor {
  new (endpoint: string, credentials: GrpcCredentialsLike): GrpcServiceClient;
}

interface GrpcServiceClient {
  close?(): void;
  [method: string]: unknown;
}

interface GrpcUnaryFunction {
  call(client: GrpcServiceClient, request: unknown,
       cb: (err: Error | null, response: unknown) => void): void;
}

interface GrpcServerStreamCall {
  on(event: 'data', cb: (chunk: unknown) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

interface GrpcServerStreamFunction {
  call(client: GrpcServiceClient, request: unknown): GrpcServerStreamCall;
}

/** grpc-js `ClientWritableStream` — a client-streaming call is write-only. */
interface GrpcWritableCall {
  write(chunk: unknown): void;
  end(): void;
}

interface GrpcClientStreamFunction {
  call(client: GrpcServiceClient,
       callback: (err: Error | null, response: unknown) => void): GrpcWritableCall;
}

interface GrpcDuplexCall {
  on(event: 'data', cb: (chunk: unknown) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  write(chunk: unknown): void;
  end(): void;
}

interface GrpcBidiFunction {
  call(client: GrpcServiceClient): GrpcDuplexCall;
}

type GrpcCredentialsLike = { /* opaque token, set by grpc.credentials.* */ };

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
