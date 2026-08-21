/**
 * Lifecycle owner of one DevTools attachment: the taps, the WebSocket
 * hub, the route tree and (when it owns the port) the HTTP binding.
 *
 * The class also implements {@link DevToolsHubContext}, so it is the
 * single place that knows which panels exist, which streams have a tap
 * behind them, and which pull methods are answerable.  Panels register
 * themselves as they land; anything unregistered is advertised to the
 * UI as unavailable *with a reason*, which is what lets the dashboard
 * render an explanatory card instead of a link that fails.
 */
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { SystemActorNames, SystemGroups } from '../internal/SystemPaths.js';
import {
  concat,
  completeJson,
  get,
  path,
  Status,
  websocket,
  withMiddleware,
  type Route,
  type ServerBinding,
} from '../http/index.js';
import {
  BUS_EVENT_BUFFER_DEFAULT,
  DEVTOOLS_PROTOCOL_VERSION,
  type DevToolsPanelDescriptor,
  type DevToolsPanelId,
  type DevToolsRequestMethod,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type WelcomeFrame,
} from './protocol/index.js';
import {
  DevToolsHubActor,
  devToolsPublishCommand,
  type DevToolsHubCommand,
  type DevToolsHubContext,
} from './internal/DevToolsHubActor.js';
import { isLoopbackHost, type DevToolsOptionsType, type DevToolsPanelOptionsType } from './DevToolsOptions.js';
import { uiAssetRoutes } from './UiAssetRoutes.js';
import { ActorTreeTap } from './taps/ActorTreeTap.js';
import { ClusterTap } from './taps/ClusterTap.js';
import { ExplainMethods } from './taps/ExplainTap.js';
import { ReplayRegistry } from './replay/ReplayRegistry.js';
import { TimeTravelMethods } from './replay/TimeTravelMethods.js';
import { DeadLetterMethods } from './deadletters/DeadLetterMethods.js';
import { EventStreamTap } from './taps/EventStreamTap.js';
import { ConfigMethods } from './config/ConfigMethods.js';
import { PersistenceExtensionId } from '../persistence/PersistenceExtension.js';
import { MailboxSamplerTap } from './taps/MailboxSamplerTap.js';
import { ProfilerTap } from './taps/ProfilerTap.js';
import { SpanTap } from './taps/SpanTap.js';
import { StatsTap } from './taps/StatsTap.js';
import { UI_ASSETS } from './generated/UiAssets.js';
import { getFromDirectory } from '../http/static/index.js';
import { freeActorName } from './internal/ActorNames.js';
import { NodeSampler } from './internal/NodeSampler.js';
import { DevToolsNodeAgent } from './cluster/NodeAgent.js';
import { DevToolsFederation } from './cluster/Federation.js';
import { ClusterMembership } from './internal/ClusterMembership.js';

/**
 * Version reported in the handshake, and shown on the overview's
 * `actor-ts` tile (#911).
 *
 * Hand-maintained, because nothing else in the build can supply it:
 * `tsc` copies no JSON, and importing `package.json` would drag the
 * repository root into `rootDir` and rearrange the whole of `dist/`.
 * It therefore drifted, silently, for two minor releases (#657) — the
 * field you trust most when triaging a bug report was the one field
 * nobody was checking.
 *
 * `DevToolsServerVersion.test.ts` now asserts it against `package.json`,
 * so a release that forgets it fails the suite instead of shipping a
 * lie.  **Bump this together with `package.json` when cutting one.**
 *
 * @internal
 */
export const DEVTOOLS_SERVER_VERSION = '0.16.0';

/** Panels that can be switched off individually, in dashboard order. */
const OPTIONAL_PANELS: ReadonlyArray<{
  readonly id: DevToolsPanelId;
  readonly option: keyof DevToolsPanelOptionsType;
}> = [
  { id: 'actors', option: 'actors' },
  { id: 'cluster', option: 'cluster' },
  { id: 'tracing', option: 'tracing' },
  { id: 'explain', option: 'explain' },
  { id: 'time-travel', option: 'timeTravel' },
  { id: 'profiler', option: 'profiler' },
  { id: 'dead-letters', option: 'deadLetters' },
  { id: 'event-stream', option: 'eventStream' },
  { id: 'config', option: 'config' },
];

/**
 * A source of stream payloads.  Taps are installed by the phase that
 * owns their panel and are expected to idle while nothing is
 * subscribed — an open DevTools tab on the dashboard should not cost
 * the system a span buffer or a profiler session.
 */
export interface DevToolsTap {
  readonly stream: DevToolsStreamId;
  /** Begin producing; `emit` is safe to call from any context. */
  install(emit: (payload: DevToolsStreamPayload) => void): void;
  /** Stop producing and release everything acquired in `install`. */
  uninstall(): void;
  /** Payloads a fresh subscriber needs before deltas make sense. */
  snapshot(): ReadonlyArray<DevToolsStreamPayload>;
  /** Subscriber count changed — the hook for idling while unobserved. */
  subscribersChanged?(count: number): void;
}

/** Handler behind one pull method. */
export type DevToolsRequestHandler = (parameters: unknown) => Promise<unknown>;

/** Handle returned by `DevTools.attach`. */
export interface DevToolsBinding {
  readonly host: string;
  readonly port: number;
  /** Browser URL of the dashboard. */
  readonly url: string;
  /** Unbind the server and uninstall every tap. */
  detach(): Promise<void>;
}

export class DevToolsServer implements DevToolsHubContext {
  private readonly taps = new Map<DevToolsStreamId, DevToolsTap>();
  private readonly methods = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  private readonly panels = new Map<DevToolsPanelId, DevToolsPanelDescriptor>();
  private hubRef: ActorRef<DevToolsHubCommand> | null = null;
  private explainMethods: ExplainMethods | null = null;
  private binding: ServerBinding | null = null;
  private stopped = false;
  /**
   * One per system: the probes and counters behind every figure, shared
   * by the local overview and the answers this node gives its peers.
   */
  private readonly sampler: NodeSampler;
  private agent: DevToolsNodeAgent | null = null;
  private federation: DevToolsFederation | null = null;
  private membership: ClusterMembership | null = null;

  constructor(
    private readonly system: ActorSystem,
    private readonly settings: DevToolsOptionsType,
  ) {
    this.sampler = new NodeSampler(system);
    this.panels.set('dashboard', { id: 'dashboard', status: 'active' });
    for (const panel of OPTIONAL_PANELS) {
      this.panels.set(panel.id, settings.panels?.[panel.option] === false
        ? { id: panel.id, status: 'disabled', reason: 'switched off in DevToolsOptions' }
        : { id: panel.id, status: 'unavailable', reason: 'not implemented in this build' });
    }
  }

  /* ---------------------------- registration --------------------------- */

  /** Install a stream source.  Call before {@link start}. */
  registerTap(tap: DevToolsTap): void {
    this.taps.set(tap.stream, tap);
    tap.install((payload) => this.publish(tap.stream, payload));
  }

  /** Register the handler behind one pull method. */
  registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
    this.methods.set(method, handler);
  }

  /** Mark a panel usable, or unusable with a reason the dashboard shows. */
  registerPanel(descriptor: DevToolsPanelDescriptor): void {
    // A panel switched off by the operator stays off — an
    // implementation announcing itself does not override that choice.
    if (this.panels.get(descriptor.id)?.status === 'disabled') return;
    this.panels.set(descriptor.id, descriptor);
  }

  /** True when the operator left `panel` enabled. */
  isPanelEnabled(panel: DevToolsPanelId): boolean {
    return this.panels.get(panel)?.status !== 'disabled';
  }

  /* ------------------------------ lifecycle ---------------------------- */

  /** Spawn the hub and install the taps.  Idempotent. */
  start(): void {
    if (this.hubRef !== null) return;
    // No `ActorOptions.withInternal()` here — the `/system/devtools` group
    // carries the tooling mark and `ActorCell` inherits it, so the hub and
    // every connection it spawns are covered without repeating it.
    this.hubRef = this.system._spawnSystemActor<DevToolsHubCommand>(
      () => new DevToolsHubActor(this) as never,
      SystemGroups.devtools,
      freeActorName(this.system, SystemGroups.devtools, SystemActorNames.devtoolsHub),
    );
    this.installDefaultTaps();
  }

  /**
   * Install the taps this system can actually support.
   *
   * The hub must exist first: a tap may emit the moment it is
   * installed, and `publish` needs somewhere to send it.
   */
  private installDefaultTaps(): void {
    const settings = this.settings;
    this.sampler.start();
    const cluster = settings.cluster ?? null;
    if (cluster !== null) {
      // Every clustered node answers for itself, and the one serving the
      // UI additionally collects.  Both run here because any node may
      // end up being the one that serves.
      this.agent = new DevToolsNodeAgent(this.system, cluster, this.sampler);
      this.agent.start();
      this.federation = new DevToolsFederation(cluster);
      this.federation.start();
      this.membership = new ClusterMembership(cluster);
    }
    const stats = new StatsTap(
      this.system,
      cluster,
      settings.statsIntervalMs ?? 1_000,
      this.sampler,
      this.federation,
      this.membership,
    );
    this.registerTap(stats);
    stats.installMethods(this);

    if (this.isPanelEnabled('actors')) {
      const sampleIntervalMs = settings.mailboxSampleIntervalMs ?? 1_000;
      this.registerTap(new ActorTreeTap(
        this.system,
        sampleIntervalMs,
        cluster?.selfAddress.toString(),
        this.federation,
      ));
      this.registerTap(new MailboxSamplerTap(
        this.system,
        sampleIntervalMs,
        settings.mailboxSampleLimit ?? 50,
      ));
      this.registerPanel({ id: 'actors', status: 'active' });
    }

    if (this.isPanelEnabled('explain')) {
      const explain = new ExplainMethods(this.system);
      explain.install(this);
      this.explainMethods = explain;
      this.registerPanel({ id: 'explain', status: 'active' });
    }

    if (this.isPanelEnabled('tracing')) {
      const spans = new SpanTap(
        this.system,
        settings.spanBufferCapacity ?? 2_000,
        settings.spanFlushIntervalMs ?? 250,
      );
      this.registerTap(spans);
      spans.installMethods(this);
      this.registerPanel({ id: 'tracing', status: 'active' });
    }

    if (this.isPanelEnabled('config')) {
      new ConfigMethods(this.system).install(this);
      this.registerPanel({ id: 'config', status: 'active' });
    }

    if (this.isPanelEnabled('event-stream')) {
      const events = new EventStreamTap(
        this.system,
        settings.eventBufferCapacity ?? BUS_EVENT_BUFFER_DEFAULT,
        settings.eventFlushIntervalMs ?? 250,
      );
      this.registerTap(events);
      events.installMethods(this);
      this.registerPanel({ id: 'event-stream', status: 'active' });
    }

    if (this.isPanelEnabled('dead-letters')) {
      const deadLetters = new DeadLetterMethods(this.system);
      deadLetters.install(this);
      // Registered either way, so a client that asks gets an empty
      // answer rather than `unknown method`.  The status is what
      // carries the reason, and a queue left `off` cannot be turned
      // on from here — `store` is fixed when the system is built.
      this.registerPanel(deadLetters.recording
        ? { id: 'dead-letters', status: 'active' }
        : {
            id: 'dead-letters',
            status: 'unavailable',
            reason: "dead-letter queue is off — set `deadLetters.store` to "
              + "'memory' or 'persistent' on the ActorSystem",
          });
    }

    if (this.isPanelEnabled('profiler')) {
      const profiler = new ProfilerTap(this.system);
      this.registerTap(profiler);
      profiler.installMethods(this);
      this.registerPanel({ id: 'profiler', status: 'active' });
    }

    if (this.isPanelEnabled('time-travel')) {
      const registry = new ReplayRegistry(
        this.system,
        settings.replayFolds ?? [],
        settings.replayAutoCapture !== false,
      );
      new TimeTravelMethods(this.system.extension(PersistenceExtensionId), registry).install(this);
      this.registerPanel({ id: 'time-travel', status: 'active' });
    }

    if (this.isPanelEnabled('cluster')) {
      if (settings.cluster === undefined) {
        this.registerPanel({
          id: 'cluster',
          status: 'unavailable',
          reason: 'this system is not clustered — pass `cluster` in DevToolsOptions',
        });
      } else {
        this.registerTap(new ClusterTap(settings.cluster, this.system, this.membership!));
        this.registerPanel({ id: 'cluster', status: 'active' });
      }
    }
  }

  /** Build the route tree.  Safe to mount into any existing server. */
  routes(): Route {
    if (this.hubRef === null) {
      throw new Error('DevToolsServer.routes() called before start()');
    }
    // Same-origin is the floor, always — a WebSocket upgrade is not subject
    // to the same-origin policy, so binding to loopback keeps the tap off
    // the network but does nothing about the page the developer is browsing.
    // `allowedOrigins` widens this; it does not replace it.
    const socket = websocket(
      this.hubRef as never,
      this.settings.allowedOrigins === undefined
        ? { requireSameOrigin: true }
        : { requireSameOrigin: true, allowedOrigins: this.settings.allowedOrigins },
    );

    const api = path('api', concat(
      path('info', get(async () => completeJson(Status.OK, this.info()))),
      path('ws', socket),
    ));

    let tree: Route = this.settings.serveUi === false ? api : concat(api, this.uiRoutes());
    // Auth and the IP allowlist wrap EVERYTHING — the UI bundle and the
    // socket upgrade included.  A gate that only covers the JSON would
    // leave the actual data channel open.
    if (this.settings.auth) tree = withMiddleware(this.settings.auth, tree);
    if (this.settings.ipAllowlist) tree = withMiddleware(this.settings.ipAllowlist, tree);
    return tree;
  }

  /**
   * Start the hub and hand the route tree to someone else's server.
   *
   * The counterpart to {@link bind}: same taps, same tree, a port this
   * process does not own — which is why the warning it ends with cannot
   * be conditional on a host the way `bind`'s is.  There is none to look
   * at (#594).
   */
  mount(): Route {
    this.start();
    const tree = this.routes();
    this.warnIfMountUngated();
    return tree;
  }

  /** Start the hub and bind a dedicated HTTP server on the configured port. */
  async bind(): Promise<DevToolsBinding> {
    this.start();
    const host = this.settings.host ?? '127.0.0.1';
    const port = this.settings.port ?? 9333;
    const builder = this.settings.backend === undefined
      ? this.system.http(port, { host })
      : this.system.http(port, { host, backend: this.settings.backend });
    this.binding = await builder.bind(this.routes());

    const url = `http://${host}:${this.binding.port}`;
    this.system.log.info(`DevTools listening on ${url}`);
    this.warnIfExposed(host);
    return {
      host,
      port: this.binding.port,
      url,
      detach: () => this.stop(),
    };
  }

  /** Unbind (if this server owns a binding) and uninstall every tap. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const tap of this.taps.values()) tap.uninstall();
    this.taps.clear();
    // Leaves no actor recording behind: a ring left running because a
    // browser tab closed is a leak nobody asked for.
    this.explainMethods?.uninstall();
    this.explainMethods = null;
    this.agent?.stop();
    this.agent = null;
    this.federation?.stop();
    this.federation = null;
    this.membership = null;
    this.sampler.stop();
    if (this.binding) await this.binding.unbind();
    this.binding = null;
    if (this.hubRef) this.system.stop(this.hubRef);
    this.hubRef = null;
  }

  /* ------------------------- DevToolsHubContext ------------------------ */

  welcome(): Omit<WelcomeFrame, 'kind' | 'protocolVersion'> {
    return {
      serverVersion: DEVTOOLS_SERVER_VERSION,
      systemName: this.system.name,
      // The system's clock, not this handshake's: `welcome()` runs on
      // every `hello`, so `Date.now()` here made the uptime restart on
      // every page reload and every silent reconnect.
      startedAtMs: this.system.startedAtMs,
      streams: Array.from(this.taps.keys()),
      panels: Array.from(this.panels.values()),
    };
  }

  isStreamAvailable(stream: DevToolsStreamId): boolean {
    return this.taps.has(stream);
  }

  snapshot(stream: DevToolsStreamId): ReadonlyArray<DevToolsStreamPayload> {
    return this.taps.get(stream)?.snapshot() ?? [];
  }

  isMethodAvailable(method: DevToolsRequestMethod): boolean {
    return this.methods.has(method);
  }

  invoke(method: DevToolsRequestMethod, parameters: unknown): Promise<unknown> {
    const handler = this.methods.get(method);
    if (handler === undefined) return Promise.reject(new Error(`unknown method: ${method}`));
    // Wrapped so a handler that throws synchronously still surfaces as
    // a rejected promise the hub can turn into an error frame.
    try {
      return handler(parameters);
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  streamSubscribersChanged(stream: DevToolsStreamId, count: number): void {
    this.taps.get(stream)?.subscribersChanged?.(count);
  }

  /* -------------------------------- internals -------------------------- */

  /** Push a payload to every subscriber of `stream`. */
  private publish(stream: DevToolsStreamId, payload: DevToolsStreamPayload): void {
    this.hubRef?.tell(devToolsPublishCommand(stream, payload));
  }

  /** Handshake data as plain JSON, for `curl` and for health checks. */
  private info(): Record<string, unknown> {
    return { protocolVersion: DEVTOOLS_PROTOCOL_VERSION, ...this.welcome() };
  }

  private uiRoutes(): Route {
    // The development root serves the bundler's raw output so a panel
    // edit is a browser refresh, with no regeneration of the embedded
    // module and no server restart.
    return this.settings.uiDevelopmentRoot === undefined
      ? uiAssetRoutes(UI_ASSETS)
      : getFromDirectory(this.settings.uiDevelopmentRoot, { indexFiles: ['index.html'] });
  }

  private warnIfExposed(host: string): void {
    if (isLoopbackHost(host)) return;
    if (this.settings.auth || this.settings.ipAllowlist) return;
    this.system.log.warn(
      `DevTools is bound to ${host} WITHOUT auth or an IP allowlist. It exposes actor `
      + 'state and, where enabled, persisted events to anyone who can reach the port.',
    );
  }

  /**
   * Say out loud what `allowUngatedMount` accepted.
   *
   * The mount equivalent of {@link warnIfExposed}, and deliberately not an
   * unconditional line: a mount that carries `auth` or `ipAllowlist` is
   * gated wherever it lands and warning about it would train operators to
   * skip the one message that matters.  What is left is the case where
   * the gate was waived — the acknowledgement is then the only record
   * that anybody chose this, and a log line is where an incident is
   * reconstructed from.
   */
  private warnIfMountUngated(): void {
    if (this.settings.auth || this.settings.ipAllowlist) return;
    this.system.log.warn(
      'DevTools was mounted with `allowUngatedMount` and WITHOUT auth or an IP '
      + 'allowlist of its own. It exposes actor state and, where enabled, persisted '
      + 'events to anyone who can reach the server these routes are bound to.',
    );
  }
}
