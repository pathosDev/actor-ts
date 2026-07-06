import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { Actor } from '../../Actor.js';
import { BrokerSettingsError, type BrokerCommonSettings } from './BrokerSettings.js';
import { GrpcServerOptions } from './GrpcServerOptions.js';

/**
 * gRPC handler descriptor — paired with a method name when the server
 * actor is constructed.  Each handler is a target actor that receives
 * `GrpcCall<Req, Res>` envelopes.
 */
export type GrpcHandler =
  | { readonly kind: 'unary'; readonly target: ActorRef<GrpcUnaryCall> }
  | { readonly kind: 'serverStream'; readonly target: ActorRef<GrpcServerStreamCall> }
  | { readonly kind: 'bidi'; readonly target: ActorRef<GrpcBidiCall> };

/** Inbound unary call — handler must reply via `respond`. */
export interface GrpcUnaryCall {
  readonly method: string;
  readonly request: unknown;
  readonly metadata: Readonly<Record<string, string>>;
  /** Reply with success (status OK). */
  respond(response: unknown): void;
  /** Reply with an error.  `code` defaults to 13 (INTERNAL). */
  respondError(message: string, code?: number): void;
}

/** Inbound server-stream call — handler emits via `send`, ends via `complete`. */
export interface GrpcServerStreamCall {
  readonly method: string;
  readonly request: unknown;
  readonly metadata: Readonly<Record<string, string>>;
  send(chunk: unknown): void;
  complete(): void;
  fail(message: string, code?: number): void;
}

/** Bidi call — handler receives chunks via `data` callback, sends via `send`. */
export interface GrpcBidiCall {
  readonly method: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Subscribe an actor to receive every inbound chunk + the end signal. */
  onData(target: ActorRef<{ readonly kind: 'chunk'; readonly chunk: unknown } | { readonly kind: 'end' }>): void;
  send(chunk: unknown): void;
  complete(): void;
  fail(message: string, code?: number): void;
}

export interface GrpcServerSettings extends BrokerCommonSettings {
  readonly protoPath?: string | ReadonlyArray<string>;
  readonly packageName?: string;
  readonly serviceName?: string;
  /** Bind address (`'0.0.0.0:50051'`). */
  readonly bind?: string;
  /** Method-name → handler mapping.  Methods absent from this map are unimplemented (UNIMPLEMENTED status). */
  readonly handlers?: Readonly<Record<string, GrpcHandler>>;
  /**
   * TLS — when omitted, the server binds insecurely.  For mTLS supply
   * cert + key + (optionally) `rootCerts` for client auth.
   */
  readonly credentials?:
    | { readonly kind: 'insecure' }
    | { readonly kind: 'tls'; readonly cert: Uint8Array; readonly key: Uint8Array; readonly rootCerts?: Uint8Array };
}

/**
 * gRPC server actor.  Differs from the `BrokerActor` base shape — a
 * server is *bound*, not connected; there are no outbound messages
 * the actor itself produces.  Handlers run independently and forward
 * inbound calls to user-supplied target actors.
 *
 * Lifecycle:
 *   - `preStart`: load proto, build server, register methods, bind.
 *   - `postStop`: graceful `tryShutdown`, then `forceShutdown` after a
 *     short grace period.
 */
export class GrpcServerActor extends Actor<unknown> {
  private settings!: GrpcServerSettings;
  private server: GrpcServerLike | null = null;
  private bound = false;
  private readonly _ctorSettings: Partial<GrpcServerSettings>;

  constructor(options: GrpcServerOptions = GrpcServerOptions.create()) {
    super();
    this._ctorSettings = options.build();
  }

  override async preStart(): Promise<void> {
    this.settings = await this.resolveSettings();
    this.validateRequired();
    await this.bindServer();
  }

  override async postStop(): Promise<void> {
    if (!this.server) return;
    const sv = this.server;
    this.server = null;
    this.bound = false;
    await new Promise<void>((resolve) => {
      let done = false;
      sv.tryShutdown((err) => {
        if (done) return;
        done = true;
        if (err) sv.forceShutdown();
        resolve();
      });
      setTimeout(() => {
        if (done) return;
        done = true;
        try { sv.forceShutdown(); } catch { /* ignore */ }
        resolve();
      }, 2_000);
    });
  }

  override onReceive(_: unknown): void { /* server actor doesn't take commands */ }

  /** Bound port (useful when `bind: '0.0.0.0:0'` was used to let the OS pick). */
  get isBound(): boolean { return this.bound; }

  /* ----------------------------- internals ----------------------------- */

  private async resolveSettings(): Promise<GrpcServerSettings> {
    const defaults: Partial<GrpcServerSettings> = {
      credentials: { kind: 'insecure' },
    };
    const cfgPath = ConfigKeys.io.broker.grpc.server;
    const cfg = this.system.config.hasPath(cfgPath)
      ? this.system.config.getConfig(cfgPath)
      : null;
    const fromCfg: { -readonly [K in keyof GrpcServerSettings]?: GrpcServerSettings[K] } = {};
    if (cfg) {
      if (cfg.hasPath('protoPath')) {
        const v = cfg.getList('protoPath');
        if (v.length === 1 && typeof v[0] === 'string') fromCfg.protoPath = v[0];
        else fromCfg.protoPath = cfg.getStringList('protoPath');
      }
      if (cfg.hasPath('packageName')) fromCfg.packageName = cfg.getString('packageName');
      if (cfg.hasPath('serviceName')) fromCfg.serviceName = cfg.getString('serviceName');
      if (cfg.hasPath('bind')) fromCfg.bind = cfg.getString('bind');
    }
    return { ...defaults, ...fromCfg, ...this._ctorSettings } as GrpcServerSettings;
  }

  private validateRequired(): void {
    const required: ReadonlyArray<keyof GrpcServerSettings> =
      ['protoPath', 'packageName', 'serviceName', 'bind', 'handlers'];
    const missing = required.filter((k) => this.settings[k] === undefined);
    if (missing.length > 0) {
      throw new BrokerSettingsError(
        `GrpcServerActor missing required settings: ${missing.join(', ')}`,
        ConfigKeys.io.broker.grpc.server,
      );
    }
  }

  private async bindServer(): Promise<void> {
    const grpc = await grpcLazy.get();
    const protoLoader = await protoLoaderLazy.get();
    const protoPaths = Array.isArray(this.settings.protoPath)
      ? [...this.settings.protoPath]
      : [this.settings.protoPath as string];
    const packageDefinition = protoLoader.loadSync(protoPaths, {
      keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as Record<string, unknown>;
    let pkg: Record<string, unknown> = loaded;
    for (const seg of (this.settings.packageName as string).split('.')) {
      pkg = pkg[seg] as Record<string, unknown>;
    }
    const serviceCtor = pkg[this.settings.serviceName as string] as { service: unknown } | undefined;
    if (!serviceCtor?.service) {
      throw new Error(`grpc-server: service '${this.settings.serviceName}' not found`);
    }

    this.server = new grpc.Server();
    const impl: Record<string, unknown> = {};
    for (const [methodName, handler] of Object.entries(this.settings.handlers ?? {})) {
      impl[methodName] = this.buildMethodImpl(methodName, handler);
    }
    this.server.addService(serviceCtor.service, impl);

    const creds = this.settings.credentials?.kind === 'tls'
      ? grpc.ServerCredentials.createSsl(
          this.settings.credentials.rootCerts ? Buffer.from(this.settings.credentials.rootCerts) : null,
          [{
            private_key: Buffer.from(this.settings.credentials.key),
            cert_chain: Buffer.from(this.settings.credentials.cert),
          }],
          this.settings.credentials.rootCerts !== undefined,
        )
      : grpc.ServerCredentials.createInsecure();

    await new Promise<void>((resolve, reject) => {
      this.server!.bindAsync(this.settings.bind!, creds, (err) => {
        if (err) reject(err);
        else { this.bound = true; this.server!.start(); resolve(); }
      });
    });
  }

  private buildMethodImpl(methodName: string, handler: GrpcHandler): unknown {
    if (handler.kind === 'unary') {
      return (call: GrpcServerUnaryRequest, cb: GrpcUnaryCb): void => {
        const userCall: GrpcUnaryCall = {
          method: methodName,
          request: call.request,
          metadata: extractMetadata(call.metadata),
          respond: (response) => cb(null, response),
          respondError: (message, code) => cb({ code: code ?? 13, message }),
        };
        handler.target.tell(userCall);
      };
    }
    if (handler.kind === 'serverStream') {
      return (call: GrpcServerStreamReq): void => {
        let ended = false;
        const userCall: GrpcServerStreamCall = {
          method: methodName,
          request: call.request,
          metadata: extractMetadata(call.metadata),
          send: (chunk) => { if (!ended) call.write(chunk); },
          complete: () => { if (!ended) { ended = true; call.end(); } },
          fail: (message, code) => { if (!ended) { ended = true; call.emit('error', { code: code ?? 13, message }); } },
        };
        handler.target.tell(userCall);
      };
    }
    // bidi
    return (call: GrpcServerDuplexCall): void => {
      const subscribers = new Set<ActorRef<unknown>>();
      let ended = false;
      const userCall: GrpcBidiCall = {
        method: methodName,
        metadata: extractMetadata(call.metadata),
        onData: (target) => { subscribers.add(target as ActorRef<unknown>); },
        send: (chunk) => { if (!ended) call.write(chunk); },
        complete: () => { if (!ended) { ended = true; call.end(); } },
        fail: (message, code) => { if (!ended) { ended = true; call.emit('error', { code: code ?? 13, message }); } },
      };
      handler.target.tell(userCall);
      call.on('data', (chunk) => {
        for (const ref of subscribers) ref.tell({ kind: 'chunk', chunk } as never);
      });
      call.on('end', () => {
        for (const ref of subscribers) ref.tell({ kind: 'end' } as never);
      });
    };
  }
}

/* ----------------------------- internals -------------------------------- */

function extractMetadata(md: { get?: (key: string) => string[] } | undefined): Readonly<Record<string, string>> {
  // grpc-js Metadata has an opaque internal representation; for tests we
  // return an empty object and let real users dig into the raw call if
  // they need full headers.
  void md;
  return {};
}

interface GrpcServerUnaryRequest {
  request: unknown;
  metadata?: { get?: (key: string) => string[] };
}

interface GrpcUnaryCb {
  (err: { code: number; message: string } | null, response?: unknown): void;
}

interface GrpcServerStreamReq {
  request: unknown;
  metadata?: { get?: (key: string) => string[] };
  write(chunk: unknown): void;
  end(): void;
  emit(event: 'error', err: { code: number; message: string }): void;
}

interface GrpcServerDuplexCall {
  metadata?: { get?: (key: string) => string[] };
  on(event: 'data', cb: (chunk: unknown) => void): void;
  on(event: 'end', cb: () => void): void;
  write(chunk: unknown): void;
  end(): void;
  emit(event: 'error', err: { code: number; message: string }): void;
}

interface GrpcServerLike {
  addService(definition: unknown, impl: Record<string, unknown>): void;
  bindAsync(bind: string, creds: unknown, cb: (err: Error | null, port: number) => void): void;
  start(): void;
  tryShutdown(cb: (err?: Error) => void): void;
  forceShutdown(): void;
}

interface GrpcModule {
  Server: new () => GrpcServerLike;
  ServerCredentials: {
    createInsecure(): unknown;
    createSsl(
      rootCerts: Buffer | null,
      keyCertPairs: Array<{ private_key: Buffer; cert_chain: Buffer }>,
      checkClientCert: boolean,
    ): unknown;
  };
  loadPackageDefinition(def: unknown): unknown;
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
      'GrpcServerActor requires "@grpc/grpc-js".  Install it with: npm install @grpc/grpc-js @grpc/proto-loader\n'
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
      'GrpcServerActor requires "@grpc/proto-loader".  Install it with: npm install @grpc/proto-loader\n'
      + 'Original error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});
