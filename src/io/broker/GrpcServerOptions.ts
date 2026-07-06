/**
 * Fluent builder for {@link GrpcServerSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions} — the gRPC server actor ignores them (a server
 * is *bound*, not connected), but the base builder still provides them
 * uniformly.  `build()` snapshots the accumulated partial and feeds the
 * same merge (constructor > HOCON under `actor-ts.io.broker.grpc.server`
 * > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { GrpcServerSettings, GrpcHandler } from './GrpcServerActor.js';

export class GrpcServerOptions extends BrokerOptions<GrpcServerSettings> {
  /** Start a fresh builder.  Equivalent to `new GrpcServerOptions()`. */
  static create(): GrpcServerOptions {
    return new GrpcServerOptions();
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
  withCredentials(credentials: NonNullable<GrpcServerSettings['credentials']>): this {
    return this.set('credentials', credentials);
  }
}
