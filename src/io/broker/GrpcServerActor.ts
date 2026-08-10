import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { Actor } from '../../Actor.js';
import type { HealthCheckRegistry, HealthCheckResult } from '../../management/HealthCheck.js';
import { BrokerOptionsError } from './BrokerOptions.js';
import type { GrpcServerOptions, GrpcServerOptionsType } from './GrpcServerOptions.js';

/**
 * gRPC handler descriptor — paired with a method name when the server
 * actor is constructed.  Each handler is a target actor that receives
 * `GrpcCall<Request, Response>` envelopes.
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

/**
 * gRPC server actor.  Differs from the `BrokerActor` base shape — a
 * server is *bound*, not connected; there are no outbound messages
 * the actor itself produces.  Handlers run independently and forward
 * inbound calls to user-supplied target actors.
 *
 * Lifecycle:
 *   - `preStart`: load proto, build server, register methods, register
 *     the optional `grpc.health.v1.Health` service, bind.
 *   - `postStop`: graceful `tryShutdown`, then `forceShutdown` after a
 *     short grace period.
 */
export class GrpcServerActor extends Actor<unknown> {
  private options!: GrpcServerOptionsType;
  private server: GrpcServerLike | null = null;
  private bound = false;
  private readonly _ctorOptions: Partial<GrpcServerOptionsType>;

  constructor(options: GrpcServerOptions = {}) {
    super();
    this._ctorOptions = { ...(options as Partial<GrpcServerOptionsType>) };
  }

  override async preStart(): Promise<void> {
    this.options = await this.resolveOptions();
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

  private async resolveOptions(): Promise<GrpcServerOptionsType> {
    const defaults: Partial<GrpcServerOptionsType> = {
      credentials: { kind: 'insecure' },
    };
    const configPath = ConfigKeys.io.broker.grpc.server;
    const config = this.system.config.hasPath(configPath)
      ? this.system.config.getConfig(configPath)
      : null;
    const fromConfig: { -readonly [K in keyof GrpcServerOptionsType]?: GrpcServerOptionsType[K] } = {};
    if (config) {
      if (config.hasPath('protoPath')) {
        const protoPathList = config.getList('protoPath');
        if (protoPathList.length === 1 && typeof protoPathList[0] === 'string') fromConfig.protoPath = protoPathList[0];
        else fromConfig.protoPath = config.getStringList('protoPath');
      }
      if (config.hasPath('packageName')) fromConfig.packageName = config.getString('packageName');
      if (config.hasPath('serviceName')) fromConfig.serviceName = config.getString('serviceName');
      if (config.hasPath('bind')) fromConfig.bind = config.getString('bind');
    }
    return { ...defaults, ...fromConfig, ...this._ctorOptions } as GrpcServerOptionsType;
  }

  private validateRequired(): void {
    const required: ReadonlyArray<keyof GrpcServerOptionsType> =
      ['protoPath', 'packageName', 'serviceName', 'bind', 'handlers'];
    const missing = required.filter((k) => this.options[k] === undefined);
    if (missing.length > 0) {
      throw new BrokerOptionsError(
        `GrpcServerActor missing required options: ${missing.join(', ')}`,
        ConfigKeys.io.broker.grpc.server,
      );
    }
  }

  private async bindServer(): Promise<void> {
    const grpc = await grpcLazy.get();
    const protoLoader = await protoLoaderLazy.get();
    const protoPaths = Array.isArray(this.options.protoPath)
      ? [...this.options.protoPath]
      : [this.options.protoPath as string];
    const packageDefinition = protoLoader.loadSync(protoPaths, PROTO_LOADER_OPTIONS);
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as Record<string, unknown>;
    let pkg: Record<string, unknown> = loaded;
    for (const seg of (this.options.packageName as string).split('.')) {
      pkg = pkg[seg] as Record<string, unknown>;
    }
    const serviceConstructor = pkg[this.options.serviceName as string] as { service: unknown } | undefined;
    if (!serviceConstructor?.service) {
      throw new Error(`grpc-server: service '${this.options.serviceName}' not found`);
    }

    this.server = new grpc.Server();
    const impl: Record<string, unknown> = {};
    for (const [methodName, handler] of Object.entries(this.options.handlers ?? {})) {
      impl[methodName] = this.buildMethodImplementation(methodName, handler);
    }
    this.server.addService(serviceConstructor.service, impl);

    // Registered on the same server, before `start()` — grpc-js rejects
    // `addService` on a started server, and a second service is the
    // ordinary way to host the health protocol next to the user's.
    if (this.options.health) {
      this.addHealthService(this.server, protoLoader, this.options.health);
    }

    const creds = this.options.credentials?.kind === 'tls'
      ? grpc.ServerCredentials.createSsl(
          this.options.credentials.rootCerts ? Buffer.from(this.options.credentials.rootCerts) : null,
          [{
            private_key: Buffer.from(this.options.credentials.key),
            cert_chain: Buffer.from(this.options.credentials.cert),
          }],
          this.options.credentials.rootCerts !== undefined,
        )
      : grpc.ServerCredentials.createInsecure();

    await new Promise<void>((resolve, reject) => {
      this.server!.bindAsync(this.options.bind!, creds, (err) => {
        if (err) reject(err);
        else { this.bound = true; this.server!.start(); resolve(); }
      });
    });
  }

  /**
   * Register `grpc.health.v1.Health` alongside the user's service.
   *
   * The service definition is generated from a hand-written descriptor
   * through the proto-loader the actor already depends on, so health
   * checking costs no third gRPC peer dependency and no `.proto` file to
   * ship and resolve at runtime (a shipped file would have to survive
   * bundling and `dist/` layout on three runtimes).
   */
  private addHealthService(
    server: GrpcServerLike,
    protoLoader: ProtoLoaderModule,
    health: HealthCheckRegistry,
  ): void {
    const healthPackageDefinition = protoLoader.fromJSON(
      HEALTH_SERVICE_DESCRIPTOR,
      PROTO_LOADER_OPTIONS,
    ) as Record<string, unknown>;
    const healthDefinition = healthPackageDefinition[GRPC_HEALTH_SERVICE_NAME];
    if (!healthDefinition) {
      throw new Error(`grpc-server: '${GRPC_HEALTH_SERVICE_NAME}' missing from the generated package definition`);
    }
    server.addService(healthDefinition, grpcHealthCheckImplementation(
      health,
      this.options.packageName as string,
      this.options.serviceName as string,
    ));
  }

  private buildMethodImplementation(methodName: string, handler: GrpcHandler): unknown {
    if (handler.kind === 'unary') {
      return (call: GrpcServerUnaryRequest, cb: GrpcUnaryCallback): void => {
        const userCall: GrpcUnaryCall = {
          method: methodName,
          request: call.request,
          metadata: extractMetadata(call.metadata),
          respond: (response) => cb(null, response),
          respondError: (message, code) => cb({ code: code ?? GRPC_STATUS_INTERNAL, message }),
        };
        handler.target.tell(userCall);
      };
    }
    if (handler.kind === 'serverStream') {
      return (call: GrpcServerStreamRequest): void => {
        let ended = false;
        const userCall: GrpcServerStreamCall = {
          method: methodName,
          request: call.request,
          metadata: extractMetadata(call.metadata),
          send: (chunk) => { if (!ended) call.write(chunk); },
          complete: () => { if (!ended) { ended = true; call.end(); } },
          fail: (message, code) => { if (!ended) { ended = true; call.emit('error', { code: code ?? GRPC_STATUS_INTERNAL, message }); } },
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
        fail: (message, code) => { if (!ended) { ended = true; call.emit('error', { code: code ?? GRPC_STATUS_INTERNAL, message }); } },
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

/* --------------------------- health checking ---------------------------- */

/** Fully-qualified name of the standard gRPC health-checking service. */
export const GRPC_HEALTH_SERVICE_NAME = 'grpc.health.v1.Health';

/** `NOT_FOUND` — the status the health protocol prescribes for an unknown service name. */
const GRPC_STATUS_NOT_FOUND = 5;
/** `INTERNAL` — the fallback status for a handler that blew up. */
const GRPC_STATUS_INTERNAL = 13;

/**
 * `grpc.health.v1.HealthCheckResponse.ServingStatus`.  The member names are
 * the proto enum's, verbatim: this is an external wire contract, not a
 * framework vocabulary.  Only `SERVING` / `NOT_SERVING` are ever produced —
 * an unknown service name is answered with a `NOT_FOUND` status code rather
 * than a `SERVICE_UNKNOWN` payload, which is what the protocol asks for.
 */
export type GrpcServingStatus = 'UNKNOWN' | 'SERVING' | 'NOT_SERVING' | 'SERVICE_UNKNOWN';

/** grpc-js service implementation for {@link GRPC_HEALTH_SERVICE_NAME}. */
export type GrpcHealthImplementation = {
  readonly Check: (call: GrpcServerUnaryRequest, callback: GrpcUnaryCallback) => void;
};

/** Inbound `grpc.health.v1.HealthCheckRequest`. */
type GrpcHealthCheckRequest = {
  readonly service?: string;
};

/**
 * `grpc.health.v1.Health` as a protobuf.js JSON descriptor, fed to
 * `@grpc/proto-loader`'s `fromJSON`.
 *
 * Hand-written rather than shipped as a `.proto`: the whole service is two
 * single-field messages, and generating it from the loader the actor
 * already requires keeps health checking free of a third gRPC peer
 * dependency *and* free of a data file that would have to be located
 * relative to the module on Bun, Node and Deno alike.
 *
 * The field numbers and enum values are the wire format — they must match
 * `health.proto` exactly or clients decode garbage.  `Watch` is declared so
 * the service definition is complete; it is intentionally left
 * unimplemented, which makes grpc-js answer it with `UNIMPLEMENTED` (the
 * documented fallback for clients, which then poll `Check`).
 */
const HEALTH_SERVICE_DESCRIPTOR = {
  nested: {
    grpc: {
      nested: {
        health: {
          nested: {
            v1: {
              nested: {
                HealthCheckRequest: {
                  fields: { service: { type: 'string', id: 1 } },
                },
                HealthCheckResponse: {
                  fields: { status: { type: 'ServingStatus', id: 1 } },
                  nested: {
                    ServingStatus: {
                      values: { UNKNOWN: 0, SERVING: 1, NOT_SERVING: 2, SERVICE_UNKNOWN: 3 },
                    },
                  },
                },
                Health: {
                  methods: {
                    Check: {
                      requestType: 'HealthCheckRequest',
                      responseType: 'HealthCheckResponse',
                    },
                    Watch: {
                      requestType: 'HealthCheckRequest',
                      responseType: 'HealthCheckResponse',
                      responseStream: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Aggregate readiness results into a serving status — `SERVING` only if
 * every check passes, exactly the rule the management server's `/ready`
 * endpoint applies.  An empty registry is `SERVING`: registering no checks
 * is a statement that nothing gates readiness, and disagreeing with `/ready`
 * here would give the deployment two answers to the same question.
 */
export function servingStatusOf(results: ReadonlyArray<HealthCheckResult>): GrpcServingStatus {
  return results.every((r) => r.status) ? 'SERVING' : 'NOT_SERVING';
}

/**
 * Does a `HealthCheckRequest.service` address this server?
 *
 * The empty string is the protocol's "whole server" probe.  The
 * fully-qualified `<package>.<service>` name is what `grpc_health_probe
 * -service=…` and the Kubernetes gRPC probe send.  The bare service name is
 * accepted as a convenience — it is what people type, and being lenient can
 * only turn a spurious `NOT_FOUND` into a real answer, never a wrong one.
 * The health service's own name is accepted because it is registered too.
 */
export function isKnownGrpcServiceName(requested: string, packageName: string, serviceName: string): boolean {
  return requested === ''
    || requested === `${packageName}.${serviceName}`
    || requested === serviceName
    || requested === GRPC_HEALTH_SERVICE_NAME;
}

/**
 * Build the `Check` handler over a {@link HealthCheckRegistry}.  Kept a free
 * function (rather than a method) so the whole request → status path is
 * exercisable without a gRPC module, a bound socket or an actor system.
 */
export function grpcHealthCheckImplementation(
  health: HealthCheckRegistry,
  packageName: string,
  serviceName: string,
): GrpcHealthImplementation {
  return {
    Check: (call, callback) => {
      const requested = (call.request as GrpcHealthCheckRequest | undefined)?.service ?? '';
      if (!isKnownGrpcServiceName(requested, packageName, serviceName)) {
        callback({ code: GRPC_STATUS_NOT_FOUND, message: `unknown service '${requested}'` });
        return;
      }
      void health.checkReadiness().then(
        (results) => callback(null, { status: servingStatusOf(results) }),
        (e: unknown) => callback({
          code: GRPC_STATUS_INTERNAL,
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  };
}

/* ----------------------------- internals -------------------------------- */

/**
 * Shared across the user's `loadSync` and the health service's `fromJSON`
 * so both sides decode identically — `enums: String` in particular is what
 * lets the health handler answer with the readable `'SERVING'` name.
 */
const PROTO_LOADER_OPTIONS = {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
};

function extractMetadata(md: { get?: (key: string) => string[] } | undefined): Readonly<Record<string, string>> {
  // grpc-js Metadata has an opaque internal representation; for tests we
  // return an empty object and let real users dig into the raw call if
  // they need full headers.
  void md;
  return {};
}

export type GrpcServerUnaryRequest = {
  request: unknown;
  metadata?: { get?: (key: string) => string[] };
};

export interface GrpcUnaryCallback {
  (err: { code: number; message: string } | null, response?: unknown): void;
}

type GrpcServerStreamRequest = {
  request: unknown;
  metadata?: { get?: (key: string) => string[] };
  write(chunk: unknown): void;
  end(): void;
  emit(event: 'error', err: { code: number; message: string }): void;
};

type GrpcServerDuplexCall = {
  metadata?: { get?: (key: string) => string[] };
  on(event: 'data', cb: (chunk: unknown) => void): void;
  on(event: 'end', cb: () => void): void;
  write(chunk: unknown): void;
  end(): void;
  emit(event: 'error', err: { code: number; message: string }): void;
};

interface GrpcServerLike {
  addService(definition: unknown, impl: Record<string, unknown>): void;
  bindAsync(bind: string, creds: unknown, cb: (err: Error | null, port: number) => void): void;
  start(): void;
  tryShutdown(cb: (err?: Error) => void): void;
  forceShutdown(): void;
}

type GrpcModule = {
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
};

interface ProtoLoaderModule {
  loadSync(filename: string | string[], options?: object): unknown;
  /** In-memory counterpart of `loadSync` — takes a protobuf.js JSON descriptor. */
  fromJSON(json: object, options?: object): unknown;
}

/** Suggested install line — both gRPC peers are needed together. */
const GRPC_INSTALL_HINT = 'npm install @grpc/grpc-js @grpc/proto-loader';

const grpcLazy: Lazy<Promise<GrpcModule>> = Lazy.of(
  () => lazyImportModule<GrpcModule>('@grpc/grpc-js', {
    context: 'GrpcServerActor',
    installHint: GRPC_INSTALL_HINT,
  }),
);

const protoLoaderLazy: Lazy<Promise<ProtoLoaderModule>> = Lazy.of(
  () => lazyImportModule<ProtoLoaderModule>('@grpc/proto-loader', {
    context: 'GrpcServerActor',
    installHint: GRPC_INSTALL_HINT,
  }),
);
