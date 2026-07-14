import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { Middleware } from '../http/index.js';

/** Plain options-object shape accepted by the management routes factory. */
export interface ManagementRoutesOptionsType {
  /** Allow POST /cluster/leave (requires cluster). */
  readonly enableLeaveEndpoint?: boolean;
  /** Allow POST /cluster/down — operator-initiated force-down.  Off by default. */
  readonly enableDownEndpoint?: boolean;
  /** Expose `GET /metrics` in Prometheus text format.  Off by default. */
  readonly enableMetricsEndpoint?: boolean;
  /** Auth middleware for the privileged subset of management routes. */
  readonly auth?: Middleware;
  /** IP-allowlist middleware applied to every management endpoint (incl. health). */
  readonly ipAllowlist?: Middleware;
  /** Also apply `auth` to `/health` and `/ready`.  Default: false. */
  readonly authProtectHealth?: boolean;
}

/** Fluent builder for {@link ManagementRoutesOptionsType}. */
export class ManagementRoutesOptionsBuilder extends OptionsBuilder<ManagementRoutesOptionsType> {
  /** Start a fresh builder. */
  static create(): ManagementRoutesOptionsBuilder {
    return new ManagementRoutesOptionsBuilder();
  }

  /** Allow POST /cluster/leave (requires cluster). */
  withLeaveEndpoint(enable = true): this {
    return this.set('enableLeaveEndpoint', enable);
  }

  /** Allow POST /cluster/down (operator force-down). */
  withDownEndpoint(enable = true): this {
    return this.set('enableDownEndpoint', enable);
  }

  /** Expose `GET /metrics` in Prometheus text format. */
  withMetricsEndpoint(enable = true): this {
    return this.set('enableMetricsEndpoint', enable);
  }

  /** Auth middleware for the privileged routes. */
  withAuth(auth: Middleware): this {
    return this.set('auth', auth);
  }

  /** IP-allowlist middleware applied to every management endpoint. */
  withIpAllowlist(ipAllowlist: Middleware): this {
    return this.set('ipAllowlist', ipAllowlist);
  }

  /** Also apply `auth` to `/health` and `/ready`.  Default false. */
  withAuthProtectHealth(protect = true): this {
    return this.set('authProtectHealth', protect);
  }
}

/**
 * Accepted input for the management routes factory: the fluent
 * {@link ManagementRoutesOptionsBuilder} OR a plain
 * {@link ManagementRoutesOptionsType} object.
 */
export type ManagementRoutesOptions = ManagementRoutesOptionsBuilder | Partial<ManagementRoutesOptionsType>;
/** Value alias so `ManagementRoutesOptions.create()` / `new ManagementRoutesOptions()` resolve to the builder. */
export const ManagementRoutesOptions = ManagementRoutesOptionsBuilder;
