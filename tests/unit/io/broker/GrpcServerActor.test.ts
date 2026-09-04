/**
 * Unit tests for `GrpcServerActor` (#790).
 *
 * Until now this actor had no unit test at all, for the reason its
 * client counterpart used to have none: `@grpc/grpc-js` and
 * `@grpc/proto-loader` are optional peers declared in
 * `tests/integration/brokers/package.json`, not in the root manifest, so
 * they are absent here by design — and `bindServer` reached both through
 * module-private `Lazy` holders, which left everything it hands grpc-js
 * unobservable outside Docker.
 *
 * `loadGrpcModule` / `loadProtoLoader` are the seam that removes that,
 * the same shape as `GrpcClientActor.createServiceClient`.  With a fake
 * module behind them the whole of `bindServer` runs in-process, which is
 * what makes the one thing #790 adds assertable: the channel options
 * reaching `new grpc.Server(...)`.
 *
 * That argument is not a convenience.  `max_connection_idle_ms`,
 * `max_connection_age_ms`, `max_concurrent_streams` and the keepalive
 * enforcement policy are channel arguments, and a nullary `new
 * grpc.Server()` put every one of them out of reach of an operator who
 * had diagnosed connection abuse on a public bind — short of forking.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { GrpcChannelOptions } from '../../../../src/io/broker/GrpcClientOptions.js';
import { GrpcServerActor } from '../../../../src/io/broker/GrpcServerActor.js';
import type {
  GrpcProtoLoaderModule,
  GrpcServerLike,
  GrpcServerModule,
  GrpcUnaryCall,
} from '../../../../src/io/broker/GrpcServerActor.js';
import {
  GrpcServerOptions,
  type GrpcServerOptionsBuilder,
} from '../../../../src/io/broker/GrpcServerOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* ------------------------------- Fakes -------------------------------- */

/**
 * Recording stand-in for grpc-js's `Server`.
 *
 * `channelOptions` is the whole point: it is what the constructor was
 * handed, and there is no other way to observe it — grpc-js keeps
 * channel arguments internal, and none of them surface on a call.
 */
class FakeGrpcServer implements GrpcServerLike {
  readonly serviceDefinitions: unknown[] = [];
  boundTo: string | null = null;
  started = false;

  constructor(readonly channelOptions: GrpcChannelOptions | undefined) {}

  addService(definition: unknown, _implementation: Record<string, unknown>): void {
    this.serviceDefinitions.push(definition);
  }

  bindAsync(bind: string, _credentials: unknown, callback: (error: Error | null, port: number) => void): void {
    this.boundTo = bind;
    callback(null, 50_051);
  }

  start(): void { this.started = true; }
  tryShutdown(callback: (error?: Error) => void): void { callback(); }
  forceShutdown(): void { /* nothing to tear down */ }
}

/**
 * A `GrpcServerModule` whose `Server` records every construction.
 *
 * A factory rather than a shared constant so each test owns its own
 * registry — a module-level array would carry one test's servers into
 * the next, and `channelOptions` is exactly the kind of assertion an
 * `[0]` off a shared array would answer wrongly.
 */
function createFakeGrpcModule(): { module: GrpcServerModule; servers: FakeGrpcServer[] } {
  const servers: FakeGrpcServer[] = [];
  class RecordingServer extends FakeGrpcServer {
    constructor(channelOptions?: GrpcChannelOptions) {
      super(channelOptions);
      servers.push(this);
    }
  }
  return {
    servers,
    module: {
      Server: RecordingServer,
      ServerCredentials: {
        createInsecure: () => ({}),
        createSsl: () => ({}),
      },
      // Shaped for `packageName: 'echo.v1'` / `serviceName: 'EchoService'`:
      // `bindServer` walks the dotted package and reads `.service` off the
      // constructor it lands on.
      loadPackageDefinition: () => ({ 'echo': { 'v1': { 'EchoService': { service: {} } } } }),
    },
  };
}

/** The loader never has to produce anything — `loadPackageDefinition` ignores it. */
const fakeProtoLoader: GrpcProtoLoaderModule = {
  loadSync: () => ({}),
  fromJSON: () => ({}),
};

class FakeGrpcServerActor extends GrpcServerActor {
  constructor(
    options: GrpcServerOptionsBuilder,
    private readonly grpcModule: GrpcServerModule,
  ) {
    super(options);
  }

  protected override loadGrpcModule(): Promise<GrpcServerModule> {
    return Promise.resolve(this.grpcModule);
  }

  protected override loadProtoLoader(): Promise<GrpcProtoLoaderModule> {
    return Promise.resolve(fakeProtoLoader);
  }
}

/** A registered method needs a target actor; nothing here ever calls it. */
class SilentHandler extends Actor<GrpcUnaryCall> {
  override onReceive(_call: GrpcUnaryCall): void { /* no inbound calls in these tests */ }
}

/* ------------------------------ Harness ------------------------------- */

function newSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
}

function baseOptions(system: ActorSystem): GrpcServerOptionsBuilder {
  const handler = system.spawnAnonymous(SilentHandler) as unknown as ActorRef<GrpcUnaryCall>;
  return GrpcServerOptions.create()
    .withProtoPath('./fake.proto')
    .withPackageName('echo.v1')
    .withServiceName('EchoService')
    .withBind('127.0.0.1:0')
    .withHandlers({ Unary: { kind: 'unary', target: handler } });
}

/** Spawn the actor and wait until `bindServer` has run to completion. */
async function bind(
  system: ActorSystem,
  options: GrpcServerOptionsBuilder,
  grpcModule: GrpcServerModule,
): Promise<FakeGrpcServerActor> {
  const held = { current: null as FakeGrpcServerActor | null };
  system.spawnAnonymous(() => {
    const created = new FakeGrpcServerActor(options, grpcModule);
    held.current = created;
    return created;
  });
  await awaitCondition(() => held.current?.isBound === true, {
    label: 'GrpcServerActor finished binding',
  });
  return held.current!;
}

/* =============================== #790 ================================== */

describe('GrpcServerActor — channel options', () => {
  test('withChannelOptions reaches the grpc.Server constructor', async () => {
    const system = newSystem('grpc-server-channel-options');
    try {
      const fake = createFakeGrpcModule();
      const channelOptions = {
        'grpc.max_connection_idle_ms': 300_000,
        'grpc.max_connection_age_ms': 1_800_000,
        'grpc.max_concurrent_streams': 128,
        'grpc.keepalive_permit_without_calls': 1,
      };
      const serverOptions = baseOptions(system).withChannelOptions(channelOptions);
      await bind(system, serverOptions, fake.module);

      expect(fake.servers.length).toBe(1);
      expect(fake.servers[0]!.channelOptions).toEqual(channelOptions);
      // The bind itself still happened — an assertion that only proved the
      // constructor argument would pass against a server that never bound.
      expect(fake.servers[0]!.boundTo).toBe('127.0.0.1:0');
      expect(fake.servers[0]!.started).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('the argument stays undefined when nothing is configured', async () => {
    const system = newSystem('grpc-server-channel-options-unset');
    try {
      const fake = createFakeGrpcModule();
      await bind(system, baseOptions(system), fake.module);

      // Not `{}`: an empty object is a real argument, and which grpc-js
      // defaults survive one is a per-release question this framework has
      // no business answering.
      expect(fake.servers[0]!.channelOptions).toBeUndefined();
    } finally {
      await system.terminate();
    }
  });
});
