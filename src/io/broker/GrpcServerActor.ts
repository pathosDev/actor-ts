import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { Actor } from '../../Actor.js';
import { isHealthy } from '../../management/HealthCheck.js';
import type { HealthCheckRegistry, HealthCheckResult } from '../../management/HealthCheck.js';
import { BrokerOptionsError } from './BrokerOptions.js';
import type { GrpcChannelOptions } from './GrpcClientOptions.js';
import type { GrpcServerOptions, GrpcServerOptionsType } from './GrpcServerOptions.js';

type UnaryHandler = { readonly kind: 'unary'; readonly target: ActorRef<GrpcUnaryCall> };
type ServerStreamHandler = { readonly kind: 'serverStream'; readonly target: ActorRef<GrpcServerStreamCall> };
type ClientStreamHandler = { readonly kind: 'clientStream'; readonly target: ActorRef<GrpcClientStreamCall> };
type BidiHandler = { readonly kind: 'bidi'; readonly target: ActorRef<GrpcBidiCall> };

/**
 * gRPC handler descriptor — paired with a method name when the server
 * actor is constructed.  Each handler is a target actor that receives
 * `GrpcCall<Request, Response>` envelopes.  The four variants are the
 * four gRPC call classes.
 */
export type GrpcHandler = UnaryHandler | ServerStreamHandler | ClientStreamHandler | BidiHandler;

/** One chunk off a request stream, forwarded to an `onData` subscriber. */
export type GrpcChunkMessage = { readonly kind: 'chunk'; readonly chunk: unknown };
/** The client half-closed its request stream. */
export type GrpcEndMessage = { readonly kind: 'end' };
/** What an `onData` subscriber of a client-stream / bidi call receives. */
export type GrpcRequestStreamInbound = GrpcChunkMessage | GrpcEndMessage;

/** Inbound unary call — handler must reply via `respond`. */
export interface GrpcUnaryCall {
  readonly method: string;
  readonly request: unknown;
  /** The client's request headers — see {@link GrpcCallMetadata}. */
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
  /** The client's request headers — see {@link GrpcCallMetadata}. */
  readonly metadata: Readonly<Record<string, string>>;
  send(chunk: unknown): void;
  complete(): void;
  fail(message: string, code?: number): void;
}

/**
 * Inbound client-stream call — handler consumes chunks via `onData`
 * and answers **once** via `respond` / `respondError`.
 *
 * There is no `request`: a client-streaming RPC has no single request
 * message, which is exactly what distinguishes it from a unary call.
 * The reply half is a unary reply, which is what distinguishes it from
 * a bidi call.
 */
export interface GrpcClientStreamCall {
  readonly method: string;
  /** The client's request headers — see {@link GrpcCallMetadata}. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Subscribe an actor to receive every inbound chunk + the end signal. */
  onData(target: ActorRef<GrpcRequestStreamInbound>): void;
  /** Reply with success (status OK).  Only the first call takes effect. */
  respond(response: unknown): void;
  /** Reply with an error.  `code` defaults to 13 (INTERNAL). */
  respondError(message: string, code?: number): void;
}

/** Bidi call — handler receives chunks via `data` callback, sends via `send`. */
export interface GrpcBidiCall {
  readonly method: string;
  /** The client's request headers — see {@link GrpcCallMetadata}. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Subscribe an actor to receive every inbound chunk + the end signal. */
  onData(target: ActorRef<GrpcRequestStreamInbound>): void;
  send(chunk: unknown): void;
  complete(): void;
  fail(message: string, code?: number): void;
}

/**
 * gRPC server actor.  Differs from the `BrokerActor` base shape — a
 * server is *bound*, not connected; there are no outbound messages
 * the actor itself produces.  Handlers run independently and forward
 * inbound calls to user-supplied target actors, one per method, in all
 * four gRPC call classes (see {@link GrpcHandler}).
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

  /**
   * Load `@grpc/grpc-js`.
   *
   * Its own hook for the same reason `GrpcClientActor.createServiceClient`
   * is one: the two `@grpc/*` peer dependencies are heavy and not
   * installed for the unit suite, so *everything* this actor hands
   * grpc-js used to be unobservable there — including, once #790 added
   * it, the channel options a public bind is hardened with.  A subclass
   * that returns a fake module drives the whole of {@link bindServer}
   * with no peer installed.
   */
  protected loadGrpcModule(): Promise<GrpcServerModule> { return grpcLazy.get(); }

  /** Load `@grpc/proto-loader` — the counterpart to {@link loadGrpcModule}. */
  protected loadProtoLoader(): Promise<GrpcProtoLoaderModule> { return protoLoaderLazy.get(); }

  private async bindServer(): Promise<void> {
    const grpc = await this.loadGrpcModule();
    const protoLoader = await this.loadProtoLoader();
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

    // `channelOptions` is the only reachable hardening surface on a bound
    // server: max_connection_idle_ms / max_connection_age_ms /
    // max_concurrent_streams / keepalive_* are channel arguments, and
    // nothing else this actor exposes can set them (#790).  Left
    // `undefined` when unset so grpc-js applies its own defaults.
    this.server = new grpc.Server(this.options.channelOptions);
    const impl: Record<string, unknown> = {};
    for (const [methodName, handler] of Object.entries(this.options.handlers ?? {})) {
      impl[methodName] = buildGrpcMethodImplementation(methodName, handler);
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
    protoLoader: GrpcProtoLoaderModule,
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

}

/* ------------------------ method implementations ------------------------ */

/**
 * Turn one `{ methodName, handler }` pair into the grpc-js service
 * implementation function for that method.
 *
 * A free function, for the same reason
 * {@link grpcHealthCheckImplementation} is one: it touches no actor
 * state, and this way the whole call → handler → reply path of all
 * four call classes is exercisable with plain fakes — no gRPC module,
 * no bound socket, no actor system.
 */
export function buildGrpcMethodImplementation(methodName: string, handler: GrpcHandler): unknown {
  return match(handler)
    .with({ kind: 'unary' }, (h) => unaryImplementation(methodName, h))
    .with({ kind: 'serverStream' }, (h) => serverStreamImplementation(methodName, h))
    .with({ kind: 'clientStream' }, (h) => clientStreamImplementation(methodName, h))
    .with({ kind: 'bidi' }, (h) => bidiImplementation(methodName, h))
    .exhaustive();
}

function unaryImplementation(methodName: string, handler: UnaryHandler) {
  return (call: GrpcServerUnaryRequest, callback: GrpcUnaryCallback): void => {
    const userCall: GrpcUnaryCall = {
      method: methodName,
      request: call.request,
      metadata: extractMetadata(call.metadata),
      respond: (response) => callback(null, response),
      respondError: (message, code) => callback({ code: code ?? GRPC_STATUS_INTERNAL, message }),
    };
    handler.target.tell(userCall);
  };
}

function serverStreamImplementation(methodName: string, handler: ServerStreamHandler) {
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

function clientStreamImplementation(methodName: string, handler: ClientStreamHandler) {
  return (call: GrpcServerReadableCall, callback: GrpcUnaryCallback): void => {
    const requests = createRequestStreamFanOut();
    let answered = false;
    const userCall: GrpcClientStreamCall = {
      method: methodName,
      metadata: extractMetadata(call.metadata),
      onData: (target) => requests.subscribe(target),
      // grpc-js treats a second callback as a protocol error, and the
      // handler runs in its own actor where nothing else can see that
      // the RPC is already answered — so the guard lives here.
      respond: (response) => { if (!answered) { answered = true; callback(null, response); } },
      respondError: (message, code) => {
        if (!answered) { answered = true; callback({ code: code ?? GRPC_STATUS_INTERNAL, message }); }
      },
    };
    handler.target.tell(userCall);
    call.on('data', (chunk) => requests.emit({ kind: 'chunk', chunk }));
    call.on('end', () => requests.emit({ kind: 'end' }));
  };
}

function bidiImplementation(methodName: string, handler: BidiHandler) {
  return (call: GrpcServerDuplexCall): void => {
    const requests = createRequestStreamFanOut();
    let ended = false;
    const userCall: GrpcBidiCall = {
      method: methodName,
      metadata: extractMetadata(call.metadata),
      onData: (target) => requests.subscribe(target),
      send: (chunk) => { if (!ended) call.write(chunk); },
      complete: () => { if (!ended) { ended = true; call.end(); } },
      fail: (message, code) => { if (!ended) { ended = true; call.emit('error', { code: code ?? GRPC_STATUS_INTERNAL, message }); } },
    };
    handler.target.tell(userCall);
    call.on('data', (chunk) => requests.emit({ kind: 'chunk', chunk }));
    call.on('end', () => requests.emit({ kind: 'end' }));
  };
}

/**
 * Fan request-stream frames out to the handler's `onData` subscribers,
 * holding anything that arrives before the first one shows up.
 *
 * The buffer is the point.  `handler.target.tell(userCall)` only
 * *enqueues* the call — the handler actor runs a turn later, so it
 * cannot possibly have called `onData` by the time grpc-js starts
 * pushing chunks at us.  Without the hold, every request-stream RPC
 * would silently lose its opening chunks, and for a client-streaming
 * call those chunks are the entire request.
 */
function createRequestStreamFanOut(): {
  subscribe(target: ActorRef<GrpcRequestStreamInbound>): void;
  emit(message: GrpcRequestStreamInbound): void;
} {
  const subscribers = new Set<ActorRef<GrpcRequestStreamInbound>>();
  const pending: GrpcRequestStreamInbound[] = [];
  return {
    subscribe: (target) => {
      subscribers.add(target);
      const replayed = pending.splice(0, pending.length);
      for (const message of replayed) target.tell(message);
    },
    emit: (message) => {
      if (subscribers.size === 0) { pending.push(message); return; }
      for (const ref of subscribers) ref.tell(message);
    },
  };
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
 * Aggregate readiness results into a serving status.
 *
 * Delegates to {@link isHealthy} rather than re-deriving the rule, which is
 * the point: `/ready` calls the same function, so the two probes cannot give
 * a deployment two answers to the same question.  The empty-registry case in
 * particular is a decision documented there, not a property of `every`.
 */
export function servingStatusOf(results: ReadonlyArray<HealthCheckResult>): GrpcServingStatus {
  return isHealthy(results) ? 'SERVING' : 'NOT_SERVING';
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

/**
 * The slice of grpc-js `Metadata` the server reads off an inbound call.
 *
 * Declared structurally rather than imported: `@grpc/grpc-js` is an
 * optional peer dependency, so naming its types here would make this
 * module unloadable without it — and the same structural shape is what
 * lets the unit suite drive all four call classes with a plain fake.
 */
export type GrpcCallMetadata = {
  /**
   * grpc-js `Metadata.getMap()`.  Optional because a call may arrive
   * without metadata at all; the values are `unknown` rather than
   * `string` because grpc-js hands back a `Buffer` for every `-bin` key.
   */
  getMap?: () => Record<string, unknown>;
};

/**
 * The suffix gRPC reserves for binary headers.  Their values arrive as a
 * `Buffer`, which `Readonly<Record<string, string>>` cannot hold, so they
 * are dropped rather than given some invented encoding that would collide
 * with a same-named text header.
 */
const GRPC_BINARY_HEADER_SUFFIX = '-bin';

/**
 * Read the request headers off an inbound call.
 *
 * Built on a **null-prototype** object, because every key here is
 * attacker-controlled: `__proto__` and `constructor` both match the token
 * grammar gRPC validates header names against, so a client may legally
 * send either.  Without a prototype, `record[key] = value` has no
 * inherited setter to reach — and, the subtler half, a lookup of a header
 * nobody sent answers `undefined` instead of some `Object.prototype`
 * member.  On a plain `{}` this record would make `metadata['constructor']`
 * truthy on *every* call, which is exactly the kind of vacuous pass a
 * per-call header check exists to prevent.
 *
 * Two documented lossy edges, both forced by the `string` value type:
 * `getMap()` collapses a repeated header to its first value, and binary
 * (`-bin`) headers are omitted entirely.
 */
function extractMetadata(metadata: GrpcCallMetadata | undefined): Readonly<Record<string, string>> {
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  const headers = metadata?.getMap?.();
  if (!headers) return record;
  for (const [key, value] of Object.entries(headers)) {
    // Both guards earn their place: the suffix is the protocol's own rule,
    // and the `typeof` check is what stops the declared type from being a
    // lie whatever a given grpc-js release decides to hand back.
    if (key.endsWith(GRPC_BINARY_HEADER_SUFFIX)) continue;
    if (typeof value !== 'string') continue;
    record[key] = value;
  }
  return record;
}

export type GrpcServerUnaryRequest = {
  request: unknown;
  metadata?: GrpcCallMetadata;
};

export interface GrpcUnaryCallback {
  (err: { code: number; message: string } | null, response?: unknown): void;
}

type GrpcServerStreamRequest = {
  request: unknown;
  metadata?: GrpcCallMetadata;
  write(chunk: unknown): void;
  end(): void;
  emit(event: 'error', err: { code: number; message: string }): void;
};

/**
 * grpc-js `ServerReadableStream` — a client-streaming call reads the
 * request stream and answers through the unary callback, so it has no
 * `write` / `end` of its own.
 */
export type GrpcServerReadableCall = {
  metadata?: GrpcCallMetadata;
  on(event: 'data', listener: (chunk: unknown) => void): void;
  on(event: 'end', listener: () => void): void;
};

type GrpcServerDuplexCall = {
  metadata?: GrpcCallMetadata;
  on(event: 'data', listener: (chunk: unknown) => void): void;
  on(event: 'end', listener: () => void): void;
  write(chunk: unknown): void;
  end(): void;
  emit(event: 'error', err: { code: number; message: string }): void;
};

/*
 * The three structural shims below are exported for the same reason the
 * call-class ones above are: they are the whole contract a
 * {@link GrpcServerActor.loadGrpcModule} / `loadProtoLoader` override has
 * to satisfy, so a fake module can be written — in this repo's unit suite
 * or in a user's — without `@grpc/grpc-js` installed.  They describe
 * grpc-js's shape; they are not a re-declaration of its API.
 */

export interface GrpcServerLike {
  addService(definition: unknown, impl: Record<string, unknown>): void;
  bindAsync(bind: string, creds: unknown, callback: (err: Error | null, port: number) => void): void;
  start(): void;
  tryShutdown(callback: (err?: Error) => void): void;
  forceShutdown(): void;
}

export type GrpcServerModule = {
  /**
   * `new grpc.Server(channelOptions?)`.  The argument is the slot #790
   * opened: every connection-level bound grpc-js has — idle and age
   * reaping, concurrent streams, keepalive enforcement — is a channel
   * argument, so a nullary declaration made them unreachable.
   */
  Server: new (channelOptions?: GrpcChannelOptions) => GrpcServerLike;
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

export interface GrpcProtoLoaderModule {
  loadSync(filename: string | string[], options?: object): unknown;
  /** In-memory counterpart of `loadSync` — takes a protobuf.js JSON descriptor. */
  fromJSON(json: object, options?: object): unknown;
}

/** Suggested install line — both gRPC peers are needed together. */
const GRPC_INSTALL_HINT = 'npm install @grpc/grpc-js @grpc/proto-loader';

const grpcLazy: Lazy<Promise<GrpcServerModule>> = Lazy.of(
  () => lazyImportModule<GrpcServerModule>('@grpc/grpc-js', {
    context: 'GrpcServerActor',
    installHint: GRPC_INSTALL_HINT,
  }),
);

const protoLoaderLazy: Lazy<Promise<GrpcProtoLoaderModule>> = Lazy.of(
  () => lazyImportModule<GrpcProtoLoaderModule>('@grpc/proto-loader', {
    context: 'GrpcServerActor',
    installHint: GRPC_INSTALL_HINT,
  }),
);
