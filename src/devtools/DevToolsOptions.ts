import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { mergeOptions, stripUndefined } from '../util/OptionsMerge.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';
import type { HttpServerBackend, Middleware } from '../http/index.js';
import type { Cluster } from '../cluster/Cluster.js';
import { BUS_EVENT_BUFFER_DEFAULT } from './protocol/EventStreamFrames.js';
import type { ReplayFoldRegistration } from './replay/ReplayRegistry.js';

/**
 * Hosts that cannot be reached from another machine.  Binding anywhere
 * else turns the DevTools port into a remote debugger, which
 * {@link DevToolsOptionsValidator} refuses without an explicit opt-in.
 */
const LOOPBACK_HOSTS: ReadonlyArray<string> = ['127.0.0.1', '::1', 'localhost'];

/** Per-panel switches.  The dashboard is the shell itself and always on. */
export type DevToolsPanelOptionsType = {
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
  /**
   * Undelivered messages, from the dead-letter queue (#553).  Default
   * `true`, but the panel only reports itself active when the queue is
   * actually recording — `deadLetters.store` defaults to `'off'`.
   *
   * Shows message payloads, so it is switched off alongside
   * {@link timeTravel} anywhere the payloads are not the operator's to
   * read.
   */
  readonly deadLetters?: boolean;
  /**
   * Live tail of the event bus and the cluster PubSub topics (#553).
   * Default `true`.
   *
   * Shows every published event, payload included, so it is switched off
   * alongside {@link timeTravel} and {@link deadLetters} anywhere those
   * payloads are not the operator's to read.  Nothing is observed until a
   * panel actually subscribes.
   */
  readonly eventStream?: boolean;
  /**
   * Resolved HOCON configuration, with the source of each key (#553).
   * Default `true`.
   *
   * Values whose key names a secret are redacted before they leave the
   * process, but a configuration tree still says a great deal about a
   * deployment — hosts, ports, seed nodes, storage paths.
   */
  readonly config?: boolean;
  /**
   * Send-message action (#553).  Default `true` — but the panel is only
   * usable when {@link DevToolsOptionsType.allowMessageSending} is also
   * set, which is a separate switch on purpose.
   *
   * This one hides the panel; that one grants the capability.  A view
   * being hidden and a system being writable are different decisions.
   */
  readonly send?: boolean;
};

/** Plain options-object shape accepted by `DevTools.attach`. */
export type DevToolsOptionsType = {
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
   *
   * Only `attach` reads this: it is the acknowledgement for a *bind*, and
   * a mount never binds.  The mount equivalent is
   * {@link allowUngatedMount}.
   */
  readonly allowRemote?: boolean;
  /**
   * Acknowledge that DevTools may **send messages into the running
   * system** from the browser (#553).  Default `false`.
   *
   * Every other thing DevTools does is a read.  This one writes, so it
   * is off until someone says otherwise in code — and while it is off
   * the `actors.send` method is never registered, so a client that
   * knows the name is told there is no such method rather than being
   * refused by a guard.
   *
   * Two bounds hold even when it is on: the message is JSON, so it
   * cannot be a `PoisonPill` or any other class the system treats
   * specially; and the recipient must be under `/user`.
   */
  readonly allowMessageSending?: boolean;
  /**
   * Acknowledge that `DevTools.mount()` may return a route tree DevTools
   * does not gate itself.  Default `false`, and the validator rejects a
   * mount without it.
   *
   * `attach` can decide on its own: it owns the port, so `host` tells it
   * whether anything off the machine can reach the tap.  A mount owns
   * nothing — the routes go to a server this process never sees, on an
   * interface it is never told about — so there is no fact in these
   * options it could reason from.  Requiring the acknowledgement is the
   * only way the two paths hold the same line.
   *
   * Set it when the surrounding server already gates the subtree (its own
   * auth middleware wraps the mount point), or when you accept an open
   * debugger.  Passing `auth` or `ipAllowlist` instead is stronger: those
   * ride on the returned tree, so the gate cannot be lost by mounting it
   * in the wrong place.
   */
  readonly allowUngatedMount?: boolean;
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
   * Additional origins allowed to open the DevTools WebSocket.  Same-origin
   * is always accepted — the UI is served from the DevTools server itself,
   * so it needs no entry here — and anything else is rejected with 403.  Set
   * this only to admit a UI served from somewhere else.
   *
   * A missing `Origin` is allowed: CSWSH needs a browser, and a browser
   * always sends one.  Unset → same-origin only.
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
   * Ceiling on events the bus tail buffers between flushes.  Default `500`.
   *
   * Past it the oldest are dropped and the panel is told how many — a tail
   * that silently skips is worse than one that admits it.
   */
  readonly eventBufferCapacity?: number;
  /** How often buffered events are flushed to the panel, in ms.  Default `250`. */
  readonly eventFlushIntervalMs?: number;
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
};

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

  /** Acknowledge that DevTools may send messages into the system. */
  withAllowMessageSending(allow = true): this {
    return this.set('allowMessageSending', allow);
  }

  /** Acknowledge mounting a route tree DevTools does not gate itself. */
  withAllowUngatedMount(allow = true): this {
    return this.set('allowUngatedMount', allow);
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

  /** Ceiling on events the bus tail buffers between flushes. */
  withEventBufferCapacity(capacity: number): this {
    return this.set('eventBufferCapacity', capacity);
  }

  /** How often buffered events are flushed to the panel, in ms. */
  withEventFlushIntervalMs(intervalMs: number): this {
    return this.set('eventFlushIntervalMs', intervalMs);
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
 * Which of the two paths a set of DevTools options is being validated
 * for — the one fact the security rule turns on.
 *
 * The names are the two public entry points, `DevTools.attach` and
 * `DevTools.mount`.  There is deliberately no default: the rule is laxer
 * on one path than the other, and a forgotten argument must be a compile
 * error rather than a silent downgrade to the laxer one.
 */
export type DevToolsExposure = 'attach' | 'mount';

/**
 * Domain checks for {@link DevToolsOptionsType}, run once on the merged
 * settings inside `DevTools.attach` and `DevTools.mount`.
 *
 * The security rule differs between the two, so the validator is told
 * which one it serves.  It is still one rule in one place: the *policy* —
 * an ungated DevTools tree must be provably unreachable, or deliberately
 * accepted — is identical, and only the available proof differs.
 */
export class DevToolsOptionsValidator extends OptionsValidator<DevToolsOptionsType> {
  constructor(
    /** Entry point these options were handed to. */
    private readonly exposure: DevToolsExposure,
  ) {
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
    this.positiveInt('eventBufferCapacity');
    this.positiveNumber('eventFlushIntervalMs');

    // The security rule this whole validator exists for: DevTools can
    // read every actor's class, mailbox and (with time travel) persisted
    // state.  Whoever reaches the tree gets all of it, so an ungated tree
    // has to be provably unreachable — or knowingly accepted.  `auth` and
    // `ipAllowlist` are that gate on either path; they wrap the tree
    // itself, so they hold wherever it ends up.
    const gated = s.auth !== undefined || s.ipAllowlist !== undefined;
    if (this.exposure === 'mount') {
      // Nothing here can stand in for the host check below.  `host` is
      // never read on this path (only `bind` looks at it), so the loopback
      // default would make every mount look safe while the caller binds
      // the returned routes to 0.0.0.0.  The acknowledgement is the only
      // signal that anybody thought about it.
      if (!gated && s.allowUngatedMount !== true) {
        this.fail(
          'allowUngatedMount',
          'must be `true` to mount DevTools without `auth` or `ipAllowlist`: '
          + '`mount()` hands its routes to a server DevTools cannot inspect, so '
          + 'it cannot tell a loopback port from a public one.  Pass `auth` or '
          + '`ipAllowlist` to gate the tree itself, or set '
          + '`allowUngatedMount: true` if the surrounding server already gates '
          + 'the mount point — or you accept an unauthenticated debugger',
        );
      }
      return;
    }
    const host = s.host;
    if (host !== undefined && !isLoopbackHost(host)) {
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

/**
 * Built-in defaults — the bottom layer of {@link mergeDevToolsOptions}, under
 * the config file and the caller's options.
 *
 * `eventBufferCapacity` and `eventFlushIntervalMs` joined it with the HOCON
 * block (#881): both were literals at their read site in `DevToolsServer`,
 * which is fine while nothing publishes them and a lie the moment
 * `reference.conf` does — a published default needs a constant to be pinned
 * against, or the two drift with nothing able to notice.
 */
export const DEVTOOLS_DEFAULTS = {
  host: '127.0.0.1',
  port: 9333,
  allowRemote: false,
  allowUngatedMount: false,
  serveUi: true,
  mailboxSampleIntervalMs: 1_000,
  mailboxSampleLimit: 50,
  statsIntervalMs: 1_000,
  spanBufferCapacity: 10_000,
  spanFlushIntervalMs: 250,
  eventBufferCapacity: BUS_EVENT_BUFFER_DEFAULT,
  eventFlushIntervalMs: 250,
  replayAutoCapture: true,
} as const satisfies Partial<DevToolsOptionsType>;

/**
 * Read `actor-ts.devtools.*` into the shape `attach` and `mount` layer under
 * the caller's options.  Only keys actually present are returned, so an
 * absent one falls through to the built-in default instead of landing as an
 * explicit `undefined` — the rule {@link mergeOptions} encodes.
 *
 * The block cannot start DevTools — `DevTools.attach(system)` is always a
 * code call — so it changes *how* an attachment behaves, never *whether* one
 * happens.  That is also why the security rule matters here rather than
 * being an afterthought: a config-sourced `host` reaches
 * {@link DevToolsOptionsValidator} exactly as a code-set one does, and since
 * `auth` and `ipAllowlist` are middleware with no HOCON form,
 * `allow-remote` is the only answer to the host rule a file can give.
 *
 * Leaves are read one literal `ConfigKeys.devtools.*` at a time rather than
 * by looping over a table: `NoDeadConfigKeys` looks for the accessor and the
 * leaf property in the same source text, and a computed key is invisible to
 * it.
 */
export function readDevToolsOptionsFromConfig(config: Config): Partial<DevToolsOptionsType> {
  const keys = ConfigKeys.devtools;
  const out: { -readonly [K in keyof DevToolsOptionsType]?: DevToolsOptionsType[K] } = {};
  if (config.hasPath(keys.host)) out.host = config.getString(keys.host);
  if (config.hasPath(keys.port)) out.port = config.getInt(keys.port);
  if (config.hasPath(keys.allowRemote)) out.allowRemote = config.getBoolean(keys.allowRemote);
  if (config.hasPath(keys.serveUi)) out.serveUi = config.getBoolean(keys.serveUi);
  if (config.hasPath(keys.allowedOrigins)) {
    out.allowedOrigins = config.getStringList(keys.allowedOrigins);
  }
  if (config.hasPath(keys.mailboxSampleInterval)) {
    out.mailboxSampleIntervalMs = config.getDuration(keys.mailboxSampleInterval);
  }
  if (config.hasPath(keys.mailboxSampleLimit)) {
    out.mailboxSampleLimit = config.getInt(keys.mailboxSampleLimit);
  }
  if (config.hasPath(keys.statsInterval)) {
    out.statsIntervalMs = config.getDuration(keys.statsInterval);
  }
  if (config.hasPath(keys.spanBufferCapacity)) {
    out.spanBufferCapacity = config.getInt(keys.spanBufferCapacity);
  }
  if (config.hasPath(keys.spanFlushInterval)) {
    out.spanFlushIntervalMs = config.getDuration(keys.spanFlushInterval);
  }
  if (config.hasPath(keys.eventBufferCapacity)) {
    out.eventBufferCapacity = config.getInt(keys.eventBufferCapacity);
  }
  if (config.hasPath(keys.eventFlushInterval)) {
    out.eventFlushIntervalMs = config.getDuration(keys.eventFlushInterval);
  }
  if (config.hasPath(keys.replayAutoCapture)) {
    out.replayAutoCapture = config.getBoolean(keys.replayAutoCapture);
  }
  const panels = readPanelsFromConfig(config);
  if (panels !== undefined) out.panels = panels;
  return out;
}

/**
 * The `panels` sub-block, on the same "absent stays absent" rule: a file that
 * names no panel yields `undefined`, not ten `undefined` switches, so it
 * cannot flatten a set of switches the caller passed in code.
 */
function readPanelsFromConfig(config: Config): DevToolsPanelOptionsType | undefined {
  const keys = ConfigKeys.devtools.panels;
  const out: { -readonly [K in keyof DevToolsPanelOptionsType]?: boolean } = {};
  if (config.hasPath(keys.actors)) out.actors = config.getBoolean(keys.actors);
  if (config.hasPath(keys.cluster)) out.cluster = config.getBoolean(keys.cluster);
  if (config.hasPath(keys.tracing)) out.tracing = config.getBoolean(keys.tracing);
  if (config.hasPath(keys.explain)) out.explain = config.getBoolean(keys.explain);
  if (config.hasPath(keys.timeTravel)) out.timeTravel = config.getBoolean(keys.timeTravel);
  if (config.hasPath(keys.profiler)) out.profiler = config.getBoolean(keys.profiler);
  if (config.hasPath(keys.deadLetters)) out.deadLetters = config.getBoolean(keys.deadLetters);
  if (config.hasPath(keys.eventStream)) out.eventStream = config.getBoolean(keys.eventStream);
  if (config.hasPath(keys.config)) out.config = config.getBoolean(keys.config);
  if (config.hasPath(keys.send)) out.send = config.getBoolean(keys.send);
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Layer the three sources in the project's precedence order — explicit
 * options over HOCON over {@link DEVTOOLS_DEFAULTS} — with the one departure
 * {@link mergeOptions} cannot make on its own.
 *
 * `mergeOptions` is shallow, which is right for every scalar field here and
 * wrong for `panels`: that is a bag of ten independent switches, so replacing
 * it wholesale turns "switch one panel off in code" into "switch every panel
 * the operator disabled in `application.conf` back on" — time travel, dead
 * letters and the event stream among them, the three that surface message
 * payloads.  Merging it switch by switch applies the same precedence one
 * level deeper: a panel set in code wins, a panel only the file mentions
 * keeps the file's answer.
 */
export function mergeDevToolsOptions(
  fromConfig: Partial<DevToolsOptionsType>,
  fromExplicit: Partial<DevToolsOptionsType>,
): DevToolsOptionsType {
  const merged = mergeOptions<DevToolsOptionsType>(DEVTOOLS_DEFAULTS, fromConfig, fromExplicit);
  const panels = mergePanels(fromConfig.panels, fromExplicit.panels);
  return panels === undefined ? merged : { ...merged, panels };
}

/** Explicit switches over configured ones, switch by switch. */
function mergePanels(
  fromConfig: DevToolsPanelOptionsType | undefined,
  fromExplicit: DevToolsPanelOptionsType | undefined,
): DevToolsPanelOptionsType | undefined {
  if (fromConfig === undefined) return fromExplicit;
  if (fromExplicit === undefined) return fromConfig;
  return { ...fromConfig, ...stripUndefined(fromExplicit) };
}
