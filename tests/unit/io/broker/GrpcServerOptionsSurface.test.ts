import { describe, expect, test } from 'bun:test';
import { BrokerActor } from '../../../../src/io/broker/BrokerActor.js';
import { BrokerOptionsBuilder } from '../../../../src/io/broker/BrokerOptions.js';
import { GrpcServerActor } from '../../../../src/io/broker/GrpcServerActor.js';
import { GrpcServerOptions, type GrpcServerOptionsType } from '../../../../src/io/broker/GrpcServerOptions.js';

/**
 * The gRPC server's builder offers only what the server reads (#1478).
 *
 * The server is *bound*, not connected: `GrpcServerActor` is a plain actor,
 * not a `BrokerActor`, so it has no reconnect cycle, no circuit breaker around
 * a connect and no outbound buffer.  Its builder used to extend the broker
 * builder all the same, so `withReconnect`, `withCircuitBreaker` and
 * `withOutboundBuffer` compiled, chained and were read by nothing — the header
 * said so, and nothing else did.  A setter that changes nothing is a setting an
 * operator believes in; with the breaker reshaped to an id it would have been
 * one more, so the server's builder now stands on the plain options builder.
 */
describe('GrpcServerOptions offers only what the gRPC server reads', () => {
  test('the server is still a plain actor, which is the reason for all of this', () => {
    expect(GrpcServerActor.prototype instanceof BrokerActor).toBe(false);
  });

  test('the builder is not a broker builder, and carries none of its setters', () => {
    const builder = GrpcServerOptions.create();
    expect(builder).not.toBeInstanceOf(BrokerOptionsBuilder);
    for (const setter of ['withReconnect', 'withCircuitBreaker', 'withOutboundBuffer']) {
      expect(setter in builder, `${setter} is still on the gRPC server builder`).toBe(false);
    }
  });

  test('a plain options object cannot carry the broker fields either', () => {
    // @ts-expect-error — `circuitBreaker` is not a gRPC server option.
    const withBreaker: Partial<GrpcServerOptionsType> = { bind: '127.0.0.1:0', circuitBreaker: 'grpc' };
    // @ts-expect-error — nor is `reconnect`.
    const withReconnect: Partial<GrpcServerOptionsType> = { bind: '127.0.0.1:0', reconnect: false };
    expect([withBreaker.bind, withReconnect.bind]).toEqual(['127.0.0.1:0', '127.0.0.1:0']);
  });

  test('the server\'s own setters still chain and land', () => {
    const grpcServerOptions = GrpcServerOptions.create()
      .withBind('127.0.0.1:0')
      .withServiceName('Orders');
    expect(grpcServerOptions.build()).toEqual({ bind: '127.0.0.1:0', serviceName: 'Orders' });
  });
});
