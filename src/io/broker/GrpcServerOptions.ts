/**
 * Fluent builder for {@link GrpcServerOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder} — the gRPC server actor ignores them (a server
 * is *bound*, not connected), but the base builder still provides them
 * uniformly.  `build()` snapshots the accumulated partial and feeds the
 * same merge (constructor > HOCON under `actor-ts.io.broker.grpc.server`
 * > built-in defaults).
 */
import { BrokerOptionsBuilder } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { HealthCheckRegistry } from '../../management/HealthCheck.js';
import type { GrpcHandler } from './GrpcServerActor.js';

export interface GrpcServerOptionsType extends BrokerCommonOptionsType {
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
  /**
   * Serve the standard `grpc.health.v1.Health` service next to the user's
   * service, answering `Check` from this registry's **readiness** checks —
   * the same source the management server's `/ready` endpoint aggregates.
   *
   * There is deliberately no boolean toggle and no HOCON leaf: the status
   * has to come from somewhere, and a health service that answers
   * `SERVING` unconditionally is worse than none at all — a Kubernetes
   * probe would keep the pod in rotation straight through an outage.
   * Supplying the registry IS the opt-in, and it makes the framework
   * carry one notion of "ready" rather than two that can disagree.
   */
  readonly health?: HealthCheckRegistry;
}

export class GrpcServerOptionsBuilder extends BrokerOptionsBuilder<GrpcServerOptionsType> {
  /** Start a fresh builder.  Equivalent to `new GrpcServerOptionsBuilder()`. */
  static create(): GrpcServerOptionsBuilder {
    return new GrpcServerOptionsBuilder();
  }

  /** Path to the `.proto` file (or array of paths). */
  withProtoPath(protoPath: string | ReadonlyArray<string>): this {
    return this.set('protoPath', protoPath);
  }

  /** gRPC package name. */
  withPackageName(packageName: string): this {
    return this.set('packageName', packageName);
  }

  /** Service name. */
  withServiceName(serviceName: string): this {
    return this.set('serviceName', serviceName);
  }

  /** Bind address (`'0.0.0.0:50051'`). */
  withBind(bind: string): this {
    return this.set('bind', bind);
  }

  /** Method-name → handler mapping.  Absent methods are UNIMPLEMENTED. */
  withHandlers(handlers: Readonly<Record<string, GrpcHandler>>): this {
    return this.set('handlers', handlers);
  }

  /** TLS credentials.  When omitted the server binds insecurely. */
  withCredentials(credentials: NonNullable<GrpcServerOptionsType['credentials']>): this {
    return this.set('credentials', credentials);
  }

  /**
   * Serve `grpc.health.v1.Health`, answering `Check` from `health`'s
   * readiness checks.  Omit the call to leave the health service off —
   * see {@link GrpcServerOptionsType.health} for why enabling it requires
   * naming a status source.
   */
  withHealth(health: HealthCheckRegistry): this {
    return this.set('health', health);
  }
}

/**
 * Accepted input for any gRPC-server-configurable constructor: the fluent
 * {@link GrpcServerOptionsBuilder} OR a plain {@link GrpcServerOptionsType} object.
 */
export type GrpcServerOptions = GrpcServerOptionsBuilder | Partial<GrpcServerOptionsType>;
/** Value alias so `GrpcServerOptions.create()` / `new GrpcServerOptions()` resolve to the builder. */
export const GrpcServerOptions = GrpcServerOptionsBuilder;
