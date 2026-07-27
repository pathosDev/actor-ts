import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { HttpServerBackend, Middleware } from '../http/index.js';

/**
 * Hosts that cannot be reached from another machine.  Binding anywhere
 * else turns the DevTools port into a remote debugger, which
 * {@link DevToolsOptionsValidator} refuses without an explicit opt-in.
 */
const LOOPBACK_HOSTS: ReadonlyArray<string> = ['127.0.0.1', '::1', 'localhost'];

/** Per-panel switches.  The dashboard is the shell itself and always on. */
export interface DevToolsPanelOptionsType {
  /** Actor tree + mailbox depths (#204).  Default `true`. */
  readonly actors?: boolean;
  /** Cluster topology, shard maps, membership timeline (#204).  Default `true`. */
  readonly cluster?: boolean;
  /** Span flame graph / waterfall (#217).  Default `true`. */
  readonly tracing?: boolean;
  /** Per-actor explain plan (#218).  Default `true`. */
  readonly explain?: boolean;
  /**
   * Journal browsing + state reconstruction (#201).  Default `true`.
   * This is the panel that exposes raw persisted events — the first
   * one to switch off when DevTools runs anywhere but a dev laptop.
   */
  readonly timeTravel?: boolean;
  /** Actor profiler (#226).  Default `true`. */
  readonly profiler?: boolean;
}

/** Plain options-object shape accepted by `DevTools.attach`. */
export interface DevToolsOptionsType {
  /** Interface to bind.  Default `'127.0.0.1'` — see {@link allowRemote}. */
  readonly host?: string;
  /**
   * Port to bind.  Default `9333`; `0` lets the operating system pick a
   * free one, which the returned binding then reports.
   */
  readonly port?: number;
  /** Auth middleware wrapping the entire DevTools tree, UI and socket included. */
  readonly auth?: Middleware;
  /** IP-allowlist middleware wrapping the entire DevTools tree. */
  readonly ipAllowlist?: Middleware;
  /**
   * Acknowledge binding a non-loopback interface without auth.  Default
   * `false`, and the validator rejects that combination — DevTools can
   * read every actor's state, so exposing it unauthenticated has to be
   * a deliberate act, not a typo in a host string.
   */
  readonly allowRemote?: boolean;
  /** HTTP backend for the DevTools server.  Default: the framework default. */
  readonly backend?: HttpServerBackend;
  /** Serve the bundled UI.  Default `true`; `false` leaves a headless tap. */
  readonly serveUi?: boolean;
  /**
   * Serve the UI from this directory instead of the embedded bundle —
   * the panel-development loop (`bun run dev:devtools`), where the
   * bundler rewrites files and a browser refresh is the whole cycle.
   * Never set this in an application.
   */
  readonly uiDevelopmentRoot?: string;
  /**
   * Origins allowed to open the DevTools WebSocket.  Default: same-origin
   * only, since the UI is served from the DevTools server itself.
   */
  readonly allowedOrigins?: ReadonlyArray<string>;
  /** Per-panel switches; unset panels default to enabled. */
  readonly panels?: DevToolsPanelOptionsType;
}

/** Fluent builder for {@link DevToolsOptionsType}. */
export class DevToolsOptionsBuilder extends OptionsBuilder<DevToolsOptionsType> {
  /** Start a fresh builder. */
  static create(): DevToolsOptionsBuilder {
    return new DevToolsOptionsBuilder();
  }

  /** Interface to bind.  Default `'127.0.0.1'`. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Port to bind.  Default `9333`; `0` picks a free port. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Auth middleware wrapping the entire DevTools tree. */
  withAuth(auth: Middleware): this {
    return this.set('auth', auth);
  }

  /** IP-allowlist middleware wrapping the entire DevTools tree. */
  withIpAllowlist(ipAllowlist: Middleware): this {
    return this.set('ipAllowlist', ipAllowlist);
  }

  /** Acknowledge binding a non-loopback interface without auth. */
  withAllowRemote(allow = true): this {
    return this.set('allowRemote', allow);
  }

  /** HTTP backend for the DevTools server. */
  withBackend(backend: HttpServerBackend): this {
    return this.set('backend', backend);
  }

  /** Serve the bundled UI.  `false` leaves a headless tap. */
  withServeUi(serve = true): this {
    return this.set('serveUi', serve);
  }

  /** Serve the UI from disk — panel development only. */
  withUiDevelopmentRoot(root: string): this {
    return this.set('uiDevelopmentRoot', root);
  }

  /** Origins allowed to open the DevTools WebSocket. */
  withAllowedOrigins(origins: ReadonlyArray<string>): this {
    return this.set('allowedOrigins', origins);
  }

  /** Per-panel switches; unset panels default to enabled. */
  withPanels(panels: DevToolsPanelOptionsType): this {
    return this.set('panels', panels);
  }
}

/**
 * Domain checks for {@link DevToolsOptionsType}, run once on the merged
 * settings inside `DevTools.attach`.
 */
export class DevToolsOptionsValidator extends OptionsValidator<DevToolsOptionsType> {
  constructor() {
    super('DevToolsOptions');
  }

  protected rules(s: Partial<DevToolsOptionsType>): void {
    // Not the `port` helper: 0 is meaningful here ("pick a free port"),
    // which is how tests and short-lived dev scripts avoid colliding on
    // 9333 when several systems run side by side.
    this.numberInRange('port', 0, 65535);
    if (s.port !== undefined && !Number.isInteger(s.port)) {
      this.fail('port', 'must be an integer', s.port);
    }
    this.nonEmptyString('host');
    this.nonEmptyString('uiDevelopmentRoot');

    // The security rule this whole validator exists for: DevTools can
    // read every actor's class, mailbox and (with time travel) persisted
    // state.  On a non-loopback interface that is a remote debugger, so
    // it needs either a gate in front of it or an explicit opt-in.
    const host = s.host;
    if (host !== undefined && !isLoopbackHost(host)) {
      const gated = s.auth !== undefined || s.ipAllowlist !== undefined;
      if (!gated && s.allowRemote !== true) {
        this.fail(
          'host',
          'binds a non-loopback interface without `auth` or `ipAllowlist`; '
          + 'pass one of them, or set `allowRemote: true` to accept an '
          + 'unauthenticated remote debugger',
          host,
        );
      }
    }
  }
}

/**
 * Accepted input for `DevTools.attach`: the fluent
 * {@link DevToolsOptionsBuilder} OR a plain {@link DevToolsOptionsType}.
 */
export type DevToolsOptions = DevToolsOptionsBuilder | Partial<DevToolsOptionsType>;
/** Value alias so `DevToolsOptions.create()` resolves to the builder. */
export const DevToolsOptions = DevToolsOptionsBuilder;

/** True when `host` cannot be reached from another machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.toLowerCase());
}

/** Built-in defaults, merged under HOCON-free explicit options. */
export const DEVTOOLS_DEFAULTS = {
  host: '127.0.0.1',
  port: 9333,
  allowRemote: false,
  serveUi: true,
} as const satisfies Partial<DevToolsOptionsType>;
