import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { MailboxDepthSampler } from './MailboxDepthSampler.js';
import {
  DefaultMetricsRegistry,
  NoopMetricsRegistry,
  type MetricsRegistry,
} from './Metrics.js';
import type { MetricsRegistryOptions } from './MetricsRegistryOptions.js';

/**
 * `MetricsExtension` — the `system.extension(MetricsExtensionId)`
 * accessor that hands back a {@link MetricsRegistry}.  By default the
 * extension creates a `NoopMetricsRegistry` (zero-cost) so framework
 * instrumentation pays nothing when the user doesn't enable metrics.
 *
 * Opt in:
 *
 *   const metrics = system.extension(MetricsExtensionId).enable();
 *   // ... or raise / disable the per-family cardinality cap:
 *   const metricsOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(50_000);
 *   system.extension(MetricsExtensionId).enable(metricsOptions);
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

  constructor(private readonly _system: ActorSystem) {}

  /** Current registry — noop until `enable()` has been called. */
  get(): MetricsRegistry { return this.registry; }

  /**
   * Replace the noop registry with a real one.  Returns the live
   * registry so callers can wire counters / gauges immediately.
   * Idempotent — repeated calls return the same instance once a real
   * registry is in place, so `options` only takes effect on the call
   * that actually installs the registry.
   */
  enable(options?: MetricsRegistryOptions): MetricsRegistry {
    if (this.registry instanceof NoopMetricsRegistry) {
      this.registry = new DefaultMetricsRegistry(options);
      this.startMailboxDepthSampler();
    }
    return this.registry;
  }

  /**
   * Plug in a custom registry — useful when you want to share a
   * single registry across multiple `ActorSystem`s (rare) or to
   * instrument with a third-party Prom client library directly.
   */
  useRegistry(registry: MetricsRegistry): void {
    this.stopMailboxDepthSampler();
    this.registry = registry;
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
    this.registry = new NoopMetricsRegistry();
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
 * Convenience accessor — `metricsOf(system)` returns the live registry
 * (or noop) without going through the extension chain at every call
 * site.  Used by ActorCell / Cluster instrumentation hooks where the
 * `MetricsExtensionId.get(...)` boilerplate would dwarf the actual
 * `counter.inc()` call.
 */
export function metricsOf(system: ActorSystem): MetricsRegistry {
  return system.extension(MetricsExtensionId).get();
}
