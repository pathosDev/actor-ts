import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { GrpcClientOptionsValidator } from './GrpcClientOptions.js';
import type { GrpcClientOptions, GrpcClientOptionsType } from './GrpcClientOptions.js';

/**
 * Inbound gRPC reply / stream frame delivered to subscribers.  The
 * `kind` discriminates between a unary completion, a stream chunk, the
 * stream-end signal, and a stream error.
 */
export type GrpcInbound =
  | { readonly kind: 'reply'; readonly target: ActorRef<unknown>; readonly response: unknown }
  | { readonly kind: 'stream-data'; readonly target: ActorRef<unknown>; readonly streamId: number; readonly chunk: unknown }
  | { readonly kind: 'stream-end'; readonly target: ActorRef<unknown>; readonly streamId: number }
  | { readonly kind: 'stream-error'; readonly target: ActorRef<unknown>; readonly streamId: number; readonly error: Error }
  | { readonly kind: 'rpc-error'; readonly target: ActorRef<unknown>; readonly error: Error };

/** TLS / mTLS credentials. */
export type GrpcCredentials =
  | { readonly kind: 'insecure' }
  | { readonly kind: 'tls'; readonly rootCerts?: Uint8Array; readonly cert?: Uint8Array; readonly key?: Uint8Array };

/** Outbound command — what the actor accepts to fire RPC calls. */
export type GrpcClientCommand =
  | { readonly kind: 'unary'; readonly method: string; readonly request: unknown; readonly target: ActorRef<unknown> }
  | { readonly kind: 'serverStream'; readonly method: string; readonly request: unknown; readonly target: ActorRef<unknown> }
  | { readonly kind: 'bidiStart'; readonly method: string; readonly target: ActorRef<unknown> }
  | { readonly kind: 'bidiSend'; readonly streamId: number; readonly chunk: unknown }
  | { readonly kind: 'bidiClose'; readonly streamId: number };

interface OutboundOp {
  readonly op: GrpcClientCommand;
}

/**
 * gRPC client actor.  One client instance per service, supports unary,
 * server-stream, and bidi-stream calls.  All inbound data (replies,
 * stream chunks) goes to the per-call `target` actor as
 * `GrpcInbound` messages.
 *
 * Bidi streams: `bidiStart` returns nothing — the actor publishes a
 * `'stream-data'` event to the target with `streamId` already filled
 * in.  Subsequent `bidiSend` / `bidiClose` reference that id.  When
 * the server closes its side, a `'stream-end'` is delivered.
 */
export class GrpcClientActor
  extends BrokerActor<GrpcClientOptionsType, GrpcClientCommand, OutboundOp> {
  private serviceClient: GrpcServiceClient | null = null;
  private nextStreamId = 1;
  private readonly bidiStreams = new Map<number, { call: GrpcDuplexCall; target: ActorRef<unknown> }>();

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
    if (this.serviceClient) {
      try { this.serviceClient.close?.(); } catch { /* ignore */ }
      this.serviceClient = null;
    }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<OutboundOp>): Promise<void> {
    if (!this.serviceClient) throw new Error('GrpcClientActor: not connected');
    const op = env.payload.op;
    if (op.kind === 'unary') {
      this.invokeUnary(op);
    } else if (op.kind === 'serverStream') {
      this.invokeServerStream(op);
    } else if (op.kind === 'bidiStart') {
      this.invokeBidiStart(op);
    } else if (op.kind === 'bidiSend') {
      const stream = this.bidiStreams.get(op.streamId);
      if (stream) stream.call.write(op.chunk);
    } else if (op.kind === 'bidiClose') {
      const stream = this.bidiStreams.get(op.streamId);
      if (stream) {
        try { stream.call.end(); } catch { /* ignore */ }
        this.bidiStreams.delete(op.streamId);
      }
    }
  }

  override onReceive(cmd: GrpcClientCommand): void {
    this.enqueueOutbound({ op: cmd });
  }

  /* ----------------------------- internals ----------------------------- */

  private invokeUnary(op: { method: string; request: unknown; target: ActorRef<unknown> }): void {
    const client = this.serviceClient;
    if (!client) return;
    const fn = (client as unknown as Record<string, GrpcUnaryFunction>)[op.method];
    if (!fn) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    fn.call(client, op.request, (err, response) => {
      if (err) op.target.tell({ kind: 'rpc-error', target: op.target, error: err } as never);
      else op.target.tell({ kind: 'reply', target: op.target, response } as never);
    });
  }

  private invokeServerStream(op: { method: string; request: unknown; target: ActorRef<unknown> }): void {
    const client = this.serviceClient;
    if (!client) return;
    const fn = (client as unknown as Record<string, GrpcServerStreamFunction>)[op.method];
    if (!fn) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    const streamId = this.nextStreamId++;
    const call = fn.call(client, op.request);
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

  private invokeBidiStart(op: { method: string; target: ActorRef<unknown> }): void {
    const client = this.serviceClient;
    if (!client) return;
    const fn = (client as unknown as Record<string, GrpcBidiFunction>)[op.method];
    if (!fn) {
      op.target.tell({ kind: 'rpc-error', target: op.target, error: new Error(`unknown method: ${op.method}`) } as never);
      return;
    }
    const streamId = this.nextStreamId++;
    const call = fn.call(client);
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

interface GrpcCredentialsLike { /* opaque token, set by grpc.credentials.* */ }

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
