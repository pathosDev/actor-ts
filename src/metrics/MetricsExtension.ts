import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { MAIN_THREAD_LABEL_VALUE, THREAD_LABEL } from './Constants.js';
import { MailboxDepthSampler } from './MailboxDepthSampler.js';
import {
  DefaultMetricsRegistry,
  NoopMetricsRegistry,
  type MetricSample,
  type MetricsRegistry,
} from './Metrics.js';
import {
  readMetricsRegistryOptionsFromConfig,
  type MetricsRegistryOptions,
  type MetricsRegistryOptionsType,
} from './MetricsRegistryOptions.js';
import { promClientRegistry } from './PromClientAdapter.js';
import {
  readPromClientAdapterOptionsFromConfig,
  type PromClientAdapterOptions,
  type PromClientAdapterOptionsType,
} from './PromClientAdapterOptions.js';

/**
 * A contributor of samples that are exported **beside** the registry's own —
 * the worker mesh's metrics relay is the one in the tree (#1570).  Called on
 * every export, so it hands back its current view rather than a copy it made
 * earlier; what it returns is rendered as-is, so it is the contributor's job
 * to have validated and stamped its samples.
 */
export type MetricSampleSource = () => ReadonlyArray<MetricSample>;

/**
 * `MetricsExtension` — the `system.extension(MetricsExtensionId)`
 * accessor that hands back a {@link MetricsRegistry}.  By default the
 * extension creates a `NoopMetricsRegistry` (zero-cost) so framework
 * instrumentation pays nothing when the user doesn't enable metrics.
 *
 * Opt in:
 *
 *   const metrics = system.extension(MetricsExtensionId).enable();
 *   // ... or raise / disable the per-family cardinality cap — in code, or
 *   // fleet-wide with actor-ts.metrics.max-series-per-family:
 *   const metricsOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(50_000);
 *   system.extension(MetricsExtensionId).enable(metricsOptions);
 *   // ... or publish into an existing prom-client registry instead:
 *   system.extension(MetricsExtensionId).enablePromClient(promOptions);
 *   // ... or pre-register a custom registry:
 *   system.extension(MetricsExtensionId).useRegistry(myCustomRegistry);
 *
 * After `enable()`, the same `system.extension(MetricsExtensionId)`
 * accessor returns the live {@link DefaultMetricsRegistry}; calls
 * before that return the noop.
 */
export class MetricsExtension implements Extension {
  private registry: MetricsRegistry = new NoopMetricsRegistry();
  /**
   * Feeds `actor_mailbox_size`.  Tied to the registry's lifetime rather
   * than the system's: it walks the actor tree on a timer, which is pure
   * overhead for a system that never turns metrics on.
   */
  private mailboxDepth: MailboxDepthSampler | null = null;
  /**
   * Contributors merged into {@link collectAll}.  A `Set` rather than an
   * array so a contributor that registers twice is exported once, and so the
   * unsubscribe is a delete rather than an index that a sibling's removal
   * shifts.
   */
  private readonly sampleSources = new Set<MetricSampleSource>();

  constructor(private readonly _system: ActorSystem) {}

  /** Current registry — noop until `enable()` has been called. */
  get(): MetricsRegistry { return this.registry; }

  /**
   * Everything an exporter should render: the registry's own samples, then
   * every registered {@link MetricSampleSource}'s (#1570).
   *
   * **The union lives here, at the export seam, and not inside the
   * registry.**  `ActorCell` reads `system._metricsRegistry` and calls
   * `counter(...)` on it once per message; a wrapping registry that merged on
   * `collect()` would sit on that path for a question only a scrape ever asks.
   * The registry stays the hot-path object, and the merge is one method that
   * `GET /metrics` calls instead of `collect()`.
   *
   * With no source registered — every system that runs no worker mesh — this
   * **is** `collect()`, the same array, so a single-threaded exposition does
   * not change by a byte.  Once a source is registered the main thread's own
   * samples are stamped `thread="main"` and the sources' samples follow, each
   * already stamped with the thread that produced it: two threads report the
   * same stock families under the same labels, and without the stamp the
   * exporter would emit two rows for one series.  While the registry is the
   * noop nothing is merged either — the relay is active only while the main
   * thread's metrics are on, and an exposition of stale worker samples with
   * no main-thread series beside them would be exactly the half-view the
   * stamp exists to prevent.
   *
   * The sources run **before** the registry is read, not after.  A source may
   * write to this registry — the relay sets a snapshot-age gauge on it every
   * time it is asked — and the reading has to include what the source just
   * wrote, or the gauge a scrape carries would be the previous scrape's.
   */
  collectAll(): ReadonlyArray<MetricSample> {
    if (this.sampleSources.size === 0 || !this.isEnabled()) return this.registry.collect();
    const contributed: MetricSample[] = [];
    for (const source of this.sampleSources) contributed.push(...source());
    const own = this.registry.collect().map((sample) => withThreadLabel(sample, MAIN_THREAD_LABEL_VALUE));
    return [...own, ...contributed];
  }

  /**
   * @internal Register a contributor to {@link collectAll}.  Returns the
   * unsubscribe.  Internal because the contract is narrower than it looks:
   * whatever the source returns is rendered raw, so a source has to own the
   * validation the registry would otherwise have done at registration — the
   * relay does — and a public seam here would be a second door past #784's
   * grammar checks.
   */
  _addSampleSource(source: MetricSampleSource): () => void {
    this.sampleSources.add(source);
    return () => { this.sampleSources.delete(source); };
  }

  /**
   * Replace the noop registry with a real one.  Returns the live
   * registry so callers can wire counters / gauges immediately.
   * Idempotent — repeated calls return the same instance once a real
   * registry is in place, so `options` only takes effect on the call
   * that actually installs the registry.
   *
   * The settings are **explicit `options` > `actor-ts.metrics` > the
   * registry's own default**, per field, and the registry's constructor
   * validates the merged result — so a cap a config file puts out of range
   * fails here exactly as the same value written in code does (#1466).
   *
   * The block is read here, from `system.config`, rather than left to callers,
   * because two framework callers enable with no options at all: DevTools
   * while it is attached, and the worker-mesh relay inside every worker.  The
   * worker's system is built from the main thread's effective config, so a
   * cap set in HOCON reaches every worker registry, while a cap passed to the
   * main thread's own `enable(options)` stays on the main thread — it was
   * never config.
   */
  enable(options?: MetricsRegistryOptions): MetricsRegistry {
    if (this.registry instanceof NoopMetricsRegistry) {
      const settings = mergeOptions<MetricsRegistryOptionsType>(
        {},
        readMetricsRegistryOptionsFromConfig(this._system.config),
        (options ?? {}) as Partial<MetricsRegistryOptionsType>,
      );
      this.install(new DefaultMetricsRegistry(settings));
      this.startMailboxDepthSampler();
    }
    return this.registry;
  }

  /**
   * Build the prom-client bridge with `actor-ts.metrics` layered under
   * `options`, install it, and return it (#1466).
   *
   * The settings are **explicit `options` > `actor-ts.metrics.name-prefix` and
   * `max-series-per-family` > the bridge's own defaults**, per field, so an
   * explicit `''` prefix is a value and wins over a configured one.  `client`
   * and `registry` are code-only — both are live objects a config file cannot
   * hold.
   *
   * The construction lives here rather than in `promClientRegistry` because
   * this is the seam that holds the system: the free function takes no config
   * and stays the pure code path, so a bridge built with it behaves exactly as
   * its options say, while a bridge built here also takes the fleet-wide
   * settings — and neither ever loads a config file of its own.
   *
   * Installs through {@link useRegistry}, so it **replaces** whatever is
   * installed, a registry `enable()` built included.  Call it once: every call
   * builds a fresh bridge, and prom-client refuses a second metric of the same
   * name in one registry.
   *
   *     const promOptions = PromClientAdapterOptions.create()
   *       .withClient(client)
   *       .withRegistry(client.register);
   *     system.extension(MetricsExtensionId).enablePromClient(promOptions);
   */
  enablePromClient(options: PromClientAdapterOptions): MetricsRegistry {
    const settings = mergeOptions<PromClientAdapterOptionsType>(
      {},
      readPromClientAdapterOptionsFromConfig(this._system.config),
      options as Partial<PromClientAdapterOptionsType>,
    );
    const bridge = promClientRegistry(settings);
    this.useRegistry(bridge);
    return bridge;
  }

  /**
   * Plug in a custom registry — useful when you want to share a
   * single registry across multiple `ActorSystem`s (rare) or to
   * instrument with a third-party Prom client library directly.
   */
  useRegistry(registry: MetricsRegistry): void {
    this.stopMailboxDepthSampler();
    this.install(registry);
    // A custom registry is still a real one, so it gets the stock gauge too
    // — the alternative is `actor_mailbox_size` silently missing for anyone
    // who plugged in their own collector.
    if (!(registry instanceof NoopMetricsRegistry)) this.startMailboxDepthSampler();
  }

  /** True if a real (non-noop) registry is installed. */
  isEnabled(): boolean {
    return !(this.registry instanceof NoopMetricsRegistry);
  }

  /**
   * Go back to the noop registry, discarding whatever was collected.
   * Mirrors `TracingExtension.disable()`, and lets a tool that switched
   * metrics on for its own use (DevTools does) leave the system as it
   * found it.
   */
  disable(): void {
    this.stopMailboxDepthSampler();
    this.install(new NoopMetricsRegistry());
  }

  /**
   * The one writer of {@link ActorSystem._metricsRegistry}, so the field and
   * this extension's own `registry` cannot drift apart.
   *
   * The system field is the hot-path mirror: it is `null` exactly when
   * {@link isEnabled} is false, which lets `ActorCell` skip building the label
   * and help objects for a counter that would throw them away (#411).  Both
   * are assigned here rather than at the three call sites because "enabled"
   * has to mean the same thing to a `metricsOf(...)` caller and to the
   * per-message check, and this method is the only place that can guarantee
   * it.
   */
  private install(registry: MetricsRegistry): void {
    this.registry = registry;
    this._system._metricsRegistry = registry instanceof NoopMetricsRegistry ? null : registry;
  }

  /**
   * @internal Force a mailbox-depth reading now instead of at the next
   * tick.  For tests and for an exporter that wants the gauge to be as
   * fresh as the scrape that asked for it.
   */
  _sampleMailboxDepth(): void {
    this.mailboxDepth?.sample();
  }

  private startMailboxDepthSampler(): void {
    this.mailboxDepth = new MailboxDepthSampler(this._system, this.registry);
    this.mailboxDepth.start();
  }

  private stopMailboxDepthSampler(): void {
    this.mailboxDepth?.stop();
    this.mailboxDepth = null;
  }
}

export const MetricsExtensionId: ExtensionId<MetricsExtension> =
  extensionId<MetricsExtension>(
    'actor-ts/metrics',
    (system) => new MetricsExtension(system),
  );

/**
 * Convenience accessor — `metricsOf(system)` returns the live registry (or the
 * noop) without the `MetricsExtensionId.get(...)` boilerplate, which would
 * otherwise dwarf the `counter.inc()` it wraps at every instrumentation site.
 *
 * **It is shorthand, not a shortcut.**  This does walk the extension chain —
 * a `Map.get` plus two calls — and the JSDoc here used to claim the opposite,
 * which is how four such lookups per message survived review (#411).  Anywhere
 * that runs once per message reads `system._metricsRegistry` directly instead;
 * this accessor is for the once-per-event sites.
 */
export function metricsOf(system: ActorSystem): MetricsRegistry {
  return system.extension(MetricsExtensionId).get();
}

/**
 * `sample` with `thread=<thread>` on it — a **copy**, never the argument.
 *
 * `collect()` hands out the registry's own label objects, and a relayed
 * snapshot's samples are stored and stamped again on every export, so
 * mutating either would write the label into the source it was read from.
 * Spread-then-set, so the stamp wins over a `thread` the sample already
 * carried: the key is reserved to the exposition (#1570).
 */
export function withThreadLabel(sample: MetricSample, thread: string): MetricSample {
  return { ...sample, labels: { ...sample.labels, [THREAD_LABEL]: thread } };
}
