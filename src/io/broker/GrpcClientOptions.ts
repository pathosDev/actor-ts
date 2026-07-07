/**
 * Fluent builder for {@link GrpcClientOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.grpc.client` > built-in defaults).
 */
import { BrokerOptionsBuilder } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerSettings.js';
import type { GrpcCredentials } from './GrpcClientActor.js';

export interface GrpcClientOptionsType extends BrokerCommonOptionsType {
  /** Path to the `.proto` file (or array of paths). */
  readonly protoPath?: string | ReadonlyArray<string>;
  /** gRPC package name (`'sensor.v1'`). */
  readonly packageName?: string;
  /** Service name (`'SensorService'`). */
  readonly serviceName?: string;
  /** Server endpoint (`'host:port'`). */
  readonly endpoint?: string;
  readonly credentials?: GrpcCredentials;
  /** Per-call deadline in ms.  Default 30_000. */
  readonly deadlineMs?: number;
}

export class GrpcClientOptionsBuilder extends BrokerOptionsBuilder<GrpcClientOptionsType> {
  /** Start a fresh builder.  Equivalent to `new GrpcClientOptionsBuilder()`. */
  static create(): GrpcClientOptionsBuilder {
    return new GrpcClientOptionsBuilder();
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

/**
 * Accepted input for any gRPC-client-configurable constructor: the fluent
 * {@link GrpcClientOptionsBuilder} OR a plain {@link GrpcClientOptionsType} object.
 */
export type GrpcClientOptions = GrpcClientOptionsBuilder | Partial<GrpcClientOptionsType>;
/** Value alias so `GrpcClientOptions.create()` / `new GrpcClientOptions()` resolve to the builder. */
export const GrpcClientOptions = GrpcClientOptionsBuilder;
