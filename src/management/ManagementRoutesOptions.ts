import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { Middleware } from '../http/index.js';

/**
 * The single path segment `GET /health` is served under.
 *
 * A built-in default of a {@link ManagementRoutesOptionsType} field, so it
 * lives here rather than in a `Constants.ts`.  Changing it silently moves a
 * documented endpoint — `/health` is what the Kubernetes manifests in the
 * management docs probe — which is why the value is written down once and
 * published from here rather than typed into `reference.conf` a second time.
 */
export const DEFAULT_LIVENESS_PATH = 'health';

/** The single path segment `GET /ready` is served under.  See {@link DEFAULT_LIVENESS_PATH}. */
export const DEFAULT_READINESS_PATH = 'ready';

/** `POST /cluster/leave` is off until an operator asks for it. */
export const DEFAULT_ENABLE_LEAVE_ENDPOINT = false;

/** `POST /cluster/down` is off until an operator asks for it. */
export const DEFAULT_ENABLE_DOWN_ENDPOINT = false;

/** `GET /metrics` is off until an operator asks for it. */
export const DEFAULT_ENABLE_METRICS_ENDPOINT = false;

/**
 * `/health` and `/ready` stay anonymous even when `auth` guards the rest.
 *
 * Off because a Kubernetes probe cannot attach credentials: an on-by-default
 * rule would turn every liveness probe into a 401 and restart the pod.
 */
export const DEFAULT_AUTH_PROTECT_HEALTH = false;

/** Plain options-object shape accepted by the management routes factory. */
export type ManagementRoutesOptionsType = {
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
  /** Path segment the liveness probe answers on.  One segment, no slashes. */
  readonly livenessPath?: string;
  /** Path segment the readiness probe answers on.  One segment, no slashes. */
  readonly readinessPath?: string;
};

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

  /** Move the liveness probe to another single path segment. */
  withLivenessPath(livenessPath: string): this {
    return this.set('livenessPath', livenessPath);
  }

  /** Move the readiness probe to another single path segment. */
  withReadinessPath(readinessPath: string): this {
    return this.set('readinessPath', readinessPath);
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

/**
 * What `managementRoutes` holds after the three layers merge: identical to
 * {@link ManagementRoutesOptionsType} except that the two probe paths are
 * resolved, because {@link defaultManagementRoutesOptions} always supplies
 * them.  Carrying that in the type is what keeps the route builder from
 * re-stating each default a second time as a `?? 'health'` — a second copy is
 * how the published value and the shipped value drift apart.
 */
export type ResolvedManagementRoutesOptions = ManagementRoutesOptionsType & {
  readonly livenessPath: string;
  readonly readinessPath: string;
};

/**
 * The lowest layer of `mergeOptions(defaults, HOCON, explicit)` — what
 * `managementRoutes` uses when neither a file nor the caller has an opinion.
 *
 * `auth` and `ipAllowlist` have no entry and cannot get one: they are
 * `Middleware` functions, so "no default" is the only expressible answer, and
 * that is also why neither has a HOCON leaf.
 */
export const defaultManagementRoutesOptions: ResolvedManagementRoutesOptions = {
  enableLeaveEndpoint: DEFAULT_ENABLE_LEAVE_ENDPOINT,
  enableDownEndpoint: DEFAULT_ENABLE_DOWN_ENDPOINT,
  enableMetricsEndpoint: DEFAULT_ENABLE_METRICS_ENDPOINT,
  authProtectHealth: DEFAULT_AUTH_PROTECT_HEALTH,
  livenessPath: DEFAULT_LIVENESS_PATH,
  readinessPath: DEFAULT_READINESS_PATH,
};

/**
 * Domain rules for the merged management-routes settings.
 *
 * The slash rule is the one that earns this class.  `path(segment, child)`
 * normalises with `stripSurrounding(segment, '/')`, which strips *surrounding*
 * slashes only — so `readiness-path = "k8s/ready"` is accepted, stored as one
 * segment that happens to contain a slash, and then matches no URL segment
 * ever.  The endpoint does not error; it silently ceases to exist, and the
 * first thing that notices is a load balancer taking the pod out of rotation.
 */
export class ManagementRoutesOptionsValidator extends OptionsValidator<ManagementRoutesOptionsType> {
  constructor() {
    super('ManagementRoutesOptions');
  }

  protected rules(s: Partial<ManagementRoutesOptionsType>): void {
    this.nonEmptyString('livenessPath');
    this.nonEmptyString('readinessPath');
    this.rejectSlashes('livenessPath', s.livenessPath);
    this.rejectSlashes('readinessPath', s.readinessPath);
  }

  /** One path segment, not a path: see the class doc for what a slash costs. */
  private rejectSlashes(field: string, value: string | undefined): void {
    if (value === undefined || !value.includes('/')) return;
    this.fail(
      field,
      'must be a single path segment without "/": a segment containing a slash matches '
      + 'no URL and the probe endpoint silently disappears',
      value,
    );
  }
}

/**
 * Read `actor-ts.management.*` into the shape `managementRoutes` layers under
 * the caller's options.  Only keys actually present are returned, so an absent
 * one falls through to the built-in default instead of landing as an explicit
 * `undefined` — the rule {@link mergeOptions} encodes.
 *
 * `auth` and `ipAllowlist` are deliberately unreachable from a file: they are
 * `Middleware` functions, which HOCON cannot express.  The block therefore
 * changes *which* endpoints exist and *where* the probes live, never *who* may
 * reach them — a config file cannot loosen the security wiring it cannot name.
 *
 * Leaves are read one literal `ConfigKeys.management.*` at a time rather than
 * by looping over a table: `NoDeadConfigKeys` looks for the accessor and the
 * leaf property in the same source text, and a computed key is invisible to it.
 */
export function readManagementRoutesOptionsFromConfig(
  config: Config,
): Partial<ManagementRoutesOptionsType> {
  const keys = ConfigKeys.management;
  const out: { -readonly [K in keyof ManagementRoutesOptionsType]?: ManagementRoutesOptionsType[K] } = {};
  if (config.hasPath(keys.enableLeaveEndpoint)) {
    out.enableLeaveEndpoint = config.getBoolean(keys.enableLeaveEndpoint);
  }
  if (config.hasPath(keys.enableDownEndpoint)) {
    out.enableDownEndpoint = config.getBoolean(keys.enableDownEndpoint);
  }
  if (config.hasPath(keys.enableMetricsEndpoint)) {
    out.enableMetricsEndpoint = config.getBoolean(keys.enableMetricsEndpoint);
  }
  if (config.hasPath(keys.authProtectHealth)) {
    out.authProtectHealth = config.getBoolean(keys.authProtectHealth);
  }
  if (config.hasPath(keys.livenessPath)) out.livenessPath = config.getString(keys.livenessPath);
  if (config.hasPath(keys.readinessPath)) out.readinessPath = config.getString(keys.readinessPath);
  return out;
}
