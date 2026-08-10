import { describe, expect, test } from 'bun:test';
import { HealthCheckRegistry } from '../../../../src/management/HealthCheck.js';
import {
  GrpcServerActor,
  GRPC_HEALTH_SERVICE_NAME,
  grpcHealthCheckImplementation,
  isKnownGrpcServiceName,
  servingStatusOf,
} from '../../../../src/io/broker/GrpcServerActor.js';
import { GrpcServerOptions, type GrpcServerOptionsType } from '../../../../src/io/broker/GrpcServerOptions.js';

/**
 * `grpc.health.v1.Health` support (#4).
 *
 * The gRPC peers (`@grpc/grpc-js`, `@grpc/proto-loader`) are not installed
 * for the unit suite — they only exist inside the Dockerized broker
 * integration image.  So the seams here are deliberately module-shaped: the
 * request → status path is a free function over a `HealthCheckRegistry`, and
 * the one place that does touch a gRPC module (`addHealthService`) takes the
 * server and the loader as arguments, so a pair of fakes exercises the
 * wiring without a socket, an actor system or a peer dependency.
 *
 * The descriptor assertions are the important half: field numbers and enum
 * values ARE the wire format, and getting one wrong would not fail
 * anywhere — it would just make `grpc_health_probe` decode garbage.
 */

/** Fakes for the two gRPC seams `addHealthService` touches. */
type CapturedService = { definition: unknown; implementation: Record<string, unknown> };

function fakeServer(captured: CapturedService[]): { addService: (d: unknown, i: Record<string, unknown>) => void } {
  return { addService: (definition, implementation) => { captured.push({ definition, implementation }); } };
}

/** Stands in for `@grpc/proto-loader` — records the descriptor it was handed. */
function fakeProtoLoader(seen: { json?: Record<string, unknown>; options?: Record<string, unknown> }) {
  return {
    loadSync: () => ({}),
    fromJSON: (json: object, options?: object) => {
      seen.json = json as Record<string, unknown>;
      seen.options = options as Record<string, unknown>;
      return { [GRPC_HEALTH_SERVICE_NAME]: { Check: { path: '/grpc.health.v1.Health/Check' } } };
    },
  };
}

/** Reach the actor's private wiring — same pattern as the TcpSocketActor framing tests. */
type HealthWiring = {
  options: Partial<GrpcServerOptionsType>;
  addHealthService: (server: unknown, protoLoader: unknown, health: HealthCheckRegistry) => void;
};

function wiringOf(packageName: string, serviceName: string): HealthWiring {
  const actor = new GrpcServerActor() as unknown as HealthWiring;
  actor.options = { packageName, serviceName };
  return actor;
}

/** Drive `Check` once and hand back whatever the callback got. */
async function check(
  health: HealthCheckRegistry,
  service: string | undefined,
  packageName = 'sensor.v1',
  serviceName = 'SensorService',
): Promise<{ error: { code: number; message: string } | null; response?: unknown }> {
  const implementation = grpcHealthCheckImplementation(health, packageName, serviceName);
  return new Promise((resolve) => {
    implementation.Check(
      { request: service === undefined ? undefined : { service } },
      (error, response) => resolve({ error, response }),
    );
  });
}

describe('servingStatusOf — readiness aggregation', () => {
  test('every check passing is SERVING', () => {
    expect(servingStatusOf([
      { name: 'journal', status: true },
      { name: 'shards', status: true },
    ])).toBe('SERVING');
  });

  test('a single failing check is NOT_SERVING', () => {
    expect(servingStatusOf([
      { name: 'journal', status: true },
      { name: 'shards', status: false, detail: 'rebalancing' },
    ])).toBe('NOT_SERVING');
  });

  // Same answer the management `/ready` endpoint gives for an empty
  // registry — registering nothing means nothing gates readiness.
  test('an empty registry is SERVING', () => {
    expect(servingStatusOf([])).toBe('SERVING');
  });
});

describe('isKnownGrpcServiceName — which probes this server answers', () => {
  const known = (requested: string): boolean => isKnownGrpcServiceName(requested, 'sensor.v1', 'SensorService');

  test('the empty string is the whole-server probe', () => {
    expect(known('')).toBe(true);
  });

  test('the fully-qualified name is what grpc_health_probe sends', () => {
    expect(known('sensor.v1.SensorService')).toBe(true);
  });

  test('the bare service name is accepted as a convenience', () => {
    expect(known('SensorService')).toBe(true);
  });

  test('the health service reports on itself', () => {
    expect(known(GRPC_HEALTH_SERVICE_NAME)).toBe(true);
  });

  test('an unrelated service is unknown', () => {
    expect(known('other.v1.OtherService')).toBe(false);
  });

  test('the right service in the wrong package is unknown', () => {
    expect(known('sensor.v2.SensorService')).toBe(false);
  });
});

describe('grpcHealthCheckImplementation — Check', () => {
  test('answers SERVING while every readiness check passes', async () => {
    const health = new HealthCheckRegistry();
    health.addReadiness(() => ({ name: 'journal', status: true }));
    const result = await check(health, '');
    expect(result.error).toBeNull();
    expect(result.response).toEqual({ status: 'SERVING' });
  });

  test('answers NOT_SERVING once a readiness check fails', async () => {
    const health = new HealthCheckRegistry();
    health.addReadiness(() => ({ name: 'journal', status: true }));
    health.addReadiness(async () => ({ name: 'shards', status: false }));
    const result = await check(health, 'sensor.v1.SensorService');
    expect(result.error).toBeNull();
    expect(result.response).toEqual({ status: 'NOT_SERVING' });
  });

  // Readiness, not liveness: gRPC health checking is what a load balancer
  // routes on, so it has to answer the same question `/ready` does.
  test('reads readiness, not liveness', async () => {
    const health = new HealthCheckRegistry();
    health.addLiveness(() => ({ name: 'process', status: false }));
    health.addReadiness(() => ({ name: 'journal', status: true }));
    const result = await check(health, '');
    expect(result.response).toEqual({ status: 'SERVING' });
  });

  // A throwing check is caught by the registry and counts as failed —
  // the health service must not turn it into a transport error.
  test('a throwing readiness check reads as NOT_SERVING', async () => {
    const health = new HealthCheckRegistry();
    health.addReadiness(() => { throw new Error('journal unreachable'); });
    const result = await check(health, '');
    expect(result.error).toBeNull();
    expect(result.response).toEqual({ status: 'NOT_SERVING' });
  });

  test('an unknown service name fails with NOT_FOUND (5)', async () => {
    const health = new HealthCheckRegistry();
    health.addReadiness(() => ({ name: 'journal', status: true }));
    const result = await check(health, 'other.v1.OtherService');
    expect(result.error?.code).toBe(5);
    expect(result.error?.message).toContain('other.v1.OtherService');
    expect(result.response).toBeUndefined();
  });

  test('a request without a service field is the whole-server probe', async () => {
    const health = new HealthCheckRegistry();
    health.addReadiness(() => ({ name: 'journal', status: true }));
    const result = await check(health, undefined);
    expect(result.error).toBeNull();
    expect(result.response).toEqual({ status: 'SERVING' });
  });

  test('the status is re-evaluated per call, not snapshotted', async () => {
    const health = new HealthCheckRegistry();
    const state = { ready: false };
    health.addReadiness(() => ({ name: 'warmup', status: state.ready }));
    expect((await check(health, '')).response).toEqual({ status: 'NOT_SERVING' });
    state.ready = true;
    expect((await check(health, '')).response).toEqual({ status: 'SERVING' });
  });
});

describe('GrpcServerActor — health service registration', () => {
  test('registers grpc.health.v1.Health as a second service', () => {
    const captured: CapturedService[] = [];
    const seen: { json?: Record<string, unknown>; options?: Record<string, unknown> } = {};
    wiringOf('sensor.v1', 'SensorService')
      .addHealthService(fakeServer(captured), fakeProtoLoader(seen), new HealthCheckRegistry());

    expect(captured.length).toBe(1);
    expect(captured[0]?.definition).toEqual({ Check: { path: '/grpc.health.v1.Health/Check' } });
  });

  // `Watch` is declared in the descriptor but deliberately unimplemented, so
  // grpc-js answers it with UNIMPLEMENTED and clients fall back to `Check`.
  test('implements Check and leaves Watch to the UNIMPLEMENTED default', () => {
    const captured: CapturedService[] = [];
    wiringOf('sensor.v1', 'SensorService')
      .addHealthService(fakeServer(captured), fakeProtoLoader({}), new HealthCheckRegistry());

    expect(Object.keys(captured[0]?.implementation ?? {})).toEqual(['Check']);
  });

  test('the registered Check answers for the served service', async () => {
    const captured: CapturedService[] = [];
    const health = new HealthCheckRegistry();
    health.addReadiness(() => ({ name: 'journal', status: false }));
    wiringOf('sensor.v1', 'SensorService')
      .addHealthService(fakeServer(captured), fakeProtoLoader({}), health);

    const registered = captured[0]?.implementation['Check'] as (
      call: { request: unknown },
      callback: (error: unknown, response?: unknown) => void,
    ) => void;
    const response = await new Promise((resolve) => {
      registered({ request: { service: 'sensor.v1.SensorService' } }, (_error, value) => resolve(value));
    });
    expect(response).toEqual({ status: 'NOT_SERVING' });
  });

  test('a package definition without the health service is an error, not a silent skip', () => {
    const brokenLoader = { loadSync: () => ({}), fromJSON: () => ({}) };
    expect(() => wiringOf('sensor.v1', 'SensorService')
      .addHealthService(fakeServer([]), brokenLoader, new HealthCheckRegistry()))
      .toThrow(GRPC_HEALTH_SERVICE_NAME);
  });
});

describe('health.proto descriptor — the wire contract', () => {
  /** The descriptor as handed to the loader; `nested` chains are the protobuf.js JSON shape. */
  function healthNamespace(): Record<string, { fields?: Record<string, { type: string; id: number }>; nested?: Record<string, { values: Record<string, number> }>; methods?: Record<string, { requestType: string; responseType: string; responseStream?: boolean }> }> {
    const seen: { json?: Record<string, unknown>; options?: Record<string, unknown> } = {};
    wiringOf('sensor.v1', 'SensorService')
      .addHealthService(fakeServer([]), fakeProtoLoader(seen), new HealthCheckRegistry());
    const root = seen.json as { nested: Record<string, { nested: Record<string, { nested: Record<string, { nested: never }> }> }> };
    return root.nested['grpc']!.nested['health']!.nested['v1']!.nested;
  }

  test('declares the three health.proto members under grpc.health.v1', () => {
    expect(Object.keys(healthNamespace()).sort())
      .toEqual(['Health', 'HealthCheckRequest', 'HealthCheckResponse']);
  });

  test('HealthCheckRequest.service is string field 1', () => {
    expect(healthNamespace()['HealthCheckRequest']?.fields).toEqual({ service: { type: 'string', id: 1 } });
  });

  test('HealthCheckResponse.status is ServingStatus field 1', () => {
    expect(healthNamespace()['HealthCheckResponse']?.fields).toEqual({ status: { type: 'ServingStatus', id: 1 } });
  });

  test('ServingStatus carries the four canonical values in order', () => {
    expect(healthNamespace()['HealthCheckResponse']?.nested?.['ServingStatus']?.values)
      .toEqual({ UNKNOWN: 0, SERVING: 1, NOT_SERVING: 2, SERVICE_UNKNOWN: 3 });
  });

  test('Health declares unary Check and server-streaming Watch', () => {
    expect(healthNamespace()['Health']?.methods).toEqual({
      Check: { requestType: 'HealthCheckRequest', responseType: 'HealthCheckResponse' },
      Watch: { requestType: 'HealthCheckRequest', responseType: 'HealthCheckResponse', responseStream: true },
    });
  });

  // The health service must decode exactly like the user's service — same
  // loader options, so `service` arrives as a plain string either way.
  test('is loaded with the same proto-loader options as the user service', () => {
    const seen: { json?: Record<string, unknown>; options?: Record<string, unknown> } = {};
    wiringOf('sensor.v1', 'SensorService')
      .addHealthService(fakeServer([]), fakeProtoLoader(seen), new HealthCheckRegistry());
    expect(seen.options).toMatchObject({ keepCase: true, defaults: true, enums: String });
  });
});

describe('GrpcServerOptions — withHealth', () => {
  test('withHealth writes the `health` field (builder ⇔ field lockstep)', () => {
    const health = new HealthCheckRegistry();
    const grpcServerOptions = GrpcServerOptions.create()
      .withBind('127.0.0.1:0')
      .withHealth(health);
    expect(grpcServerOptions.build().health).toBe(health);
  });

  test('the health service is off unless a registry is supplied', () => {
    const grpcServerOptions = GrpcServerOptions.create().withBind('127.0.0.1:0');
    expect(grpcServerOptions.build().health).toBeUndefined();
  });

  test('a plain options object is interchangeable with the builder', () => {
    const health = new HealthCheckRegistry();
    const grpcServerOptions: GrpcServerOptionsType = { bind: '127.0.0.1:0', health };
    expect(grpcServerOptions.health).toBe(health);
  });
});
