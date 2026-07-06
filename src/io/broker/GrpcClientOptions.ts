/**
 * Fluent builder for {@link GrpcClientActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.grpc.client` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { GrpcClientActorSettings, GrpcCredentials } from './GrpcClientActor.js';

export class GrpcClientOptions extends BrokerOptions<GrpcClientActorSettings> {
  /** Start a fresh builder.  Equivalent to `new GrpcClientOptions()`. */
  static create(): GrpcClientOptions {
    return new GrpcClientOptions();
  }

  /** Path to the `.proto` file (or array of paths). */
  withProtoPath(protoPath: string | ReadonlyArray<string>): this {
    return this.set('protoPath', protoPath);
  }

  /** gRPC package name (`'sensor.v1'`). */
  withPackageName(packageName: string): this {
    return this.set('packageName', packageName);
  }

  /** Service name (`'SensorService'`). */
  withServiceName(serviceName: string): this {
    return this.set('serviceName', serviceName);
  }

  /** Server endpoint (`'host:port'`). */
  withEndpoint(endpoint: string): this {
    return this.set('endpoint', endpoint);
  }

  /** TLS / mTLS credentials.  Default insecure. */
  withCredentials(credentials: GrpcCredentials): this {
    return this.set('credentials', credentials);
  }

  /** Per-call deadline in ms.  Default 30000. */
  withDeadlineMs(ms: number): this {
    return this.set('deadlineMs', ms);
  }
}
