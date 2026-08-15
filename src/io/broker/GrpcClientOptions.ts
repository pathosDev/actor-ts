/**
 * Fluent builder for {@link GrpcClientOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.grpc.client` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
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
  /**
   * Deadline for a **unary** call, in ms.  Default 30_000.
   *
   * Not applied to the three streaming call classes: a gRPC deadline
   * bounds the whole RPC, so one value cannot both fail a unary call
   * promptly and let a long-lived stream run (see #790 for the
   * channel-level keepalive that covers those).
   */
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

  /** Deadline for a unary call, in ms.  Default 30000; streams are not bounded by it. */
  withDeadlineMs(ms: number): this {
    return this.set('deadlineMs', ms);
  }
}

/** Validates resolved {@link GrpcClientOptionsType} settings. */
export class GrpcClientOptionsValidator extends BrokerOptionsValidator<GrpcClientOptionsType> {
  constructor() {
    super('GrpcClientOptions');
  }
  protected rules(_s: Partial<GrpcClientOptionsType>): void {
    this.commonRules(_s);
    this.positiveNumber('deadlineMs');
  }
}

/**
 * Accepted input for any gRPC-client-configurable constructor: the fluent
 * {@link GrpcClientOptionsBuilder} OR a plain {@link GrpcClientOptionsType} object.
 */
export type GrpcClientOptions = GrpcClientOptionsBuilder | Partial<GrpcClientOptionsType>;
/** Value alias so `GrpcClientOptions.create()` / `new GrpcClientOptions()` resolve to the builder. */
export const GrpcClientOptions = GrpcClientOptionsBuilder;
