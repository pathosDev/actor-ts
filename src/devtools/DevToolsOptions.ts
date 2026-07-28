import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { HttpServerBackend, Middleware } from '../http/index.js';
import type { Cluster } from '../cluster/Cluster.js';
import type { ReplayFoldRegistration } from './replay/ReplayRegistry.js';

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
  /**
   * Cluster to inspect.  Required for the cluster panel and for the
   * cluster figures on the dashboard — a system has no way to hand out
   * its own `Cluster`, so it has to be passed in (the same reason
   * `managementRoutes` takes one).
   */
  readonly cluster?: Cluster;
  /**
   * How often live actor state is sampled, in ms.  Default `1000`.
   *
   * Covers both mailbox depths and cell states: nothing on the event
   * stream announces a suspension or a growing stash, so the actors
   * panel only learns about them by re-inspecting on this interval.
   */
  readonly mailboxSampleIntervalMs?: number;
  /** How many mailboxes one sample carries.  Default `50`. */
  readonly mailboxSampleLimit?: number;
  /** How often dashboard figures are sampled, in ms.  Default `1000`. */
  readonly statsIntervalMs?: number;
  /**
   * Ceiling on retained spans, in messages.  Default `10000`.
   *
   * Tracing records from the moment DevTools attaches, so there is
   * always a recent history to open the panel onto.  The panel chooses
   * how much of it to keep — this is the most it may ask for.
   */
  readonly spanBufferCapacity?: number;
  /** How often buffered spans are flushed to the panel, in ms.  Default `250`. */
  readonly spanFlushIntervalMs?: number;
  /**
   * Folds the time-travel panel uses to reconstruct state.
   *
   * Only needed for persistence ids whose actor is not running — a live
   * `PersistentActor` lends its own `onEvent` automatically.
   */
  readonly replayFolds?: ReadonlyArray<ReplayFoldRegistration>;
  /**
   * Borrow a fold from a running `PersistentActor`.  Default `true`.
   * Turn off if you would rather see raw events than a state derived
   * from an `onEvent` you have not vetted for purity.
   */
  readonly replayAutoCapture?: boolean;
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

  /** Cluster to inspect — enables the cluster panel. */
  withCluster(cluster: Cluster): this {
    return this.set('cluster', cluster);
  }

  /** How often live actor state (depths and cell states) is sampled, in ms. */
  withMailboxSampleIntervalMs(intervalMs: number): this {
    return this.set('mailboxSampleIntervalMs', intervalMs);
  }

  /** How many mailboxes one sample carries. */
  withMailboxSampleLimit(limit: number): this {
    return this.set('mailboxSampleLimit', limit);
  }

  /** How often dashboard figures are sampled, in ms. */
  withStatsIntervalMs(intervalMs: number): this {
    return this.set('statsIntervalMs', intervalMs);
  }

  /** Ceiling on retained spans, in messages. */
  withSpanBufferCapacity(capacity: number): this {
    return this.set('spanBufferCapacity', capacity);
  }

  /** How often buffered spans are flushed to the panel, in ms. */
  withSpanFlushIntervalMs(intervalMs: number): this {
    return this.set('spanFlushIntervalMs', intervalMs);
  }

  /** Folds the time-travel panel uses to reconstruct state. */
  withReplayFolds(folds: ReadonlyArray<ReplayFoldRegistration>): this {
    return this.set('replayFolds', folds);
  }

  /** Borrow a fold from a running `PersistentActor`.  Default `true`. */
  withReplayAutoCapture(enabled = true): this {
    return this.set('replayAutoCapture', enabled);
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
    this.positiveNumber('mailboxSampleIntervalMs');
    this.positiveNumber('statsIntervalMs');
    this.positiveInt('mailboxSampleLimit');
    this.positiveInt('spanBufferCapacity');
    this.positiveNumber('spanFlushIntervalMs');

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
  mailboxSampleIntervalMs: 1_000,
  mailboxSampleLimit: 50,
  statsIntervalMs: 1_000,
  spanBufferCapacity: 10_000,
  spanFlushIntervalMs: 250,
  replayAutoCapture: true,
} as const satisfies Partial<DevToolsOptionsType>;
