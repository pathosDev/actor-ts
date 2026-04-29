import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import {
  DefaultMetricsRegistry,
  NoopMetricsRegistry,
  type MetricsRegistry,
} from './Metrics.js';

/**
 * `MetricsExtension` — the `system.extension(MetricsExtensionId)`
 * accessor that hands back a {@link MetricsRegistry}.  By default the
 * extension creates a `NoopMetricsRegistry` (zero-cost) so framework
 * instrumentation pays nothing when the user doesn't enable metrics.
 *
 * Opt in:
 *
 *   const metrics = system.extension(MetricsExtensionId).enable();
 *   // ... or pre-register a custom registry:
 *   system.extension(MetricsExtensionId).useRegistry(myCustomRegistry);
 *
 * After `enable()`, the same `system.extension(MetricsExtensionId)`
 * accessor returns the live {@link DefaultMetricsRegistry}; calls
 * before that return the noop.
 */
export class MetricsExtension implements Extension {
  private registry: MetricsRegistry = new NoopMetricsRegistry();

  constructor(private readonly _system: ActorSystem) {}

  /** Current registry — noop until `enable()` has been called. */
  get(): MetricsRegistry { return this.registry; }

  /**
   * Replace the noop registry with a real one.  Returns the live
   * registry so callers can wire counters / gauges immediately.
   * Idempotent — repeated calls return the same instance once a real
   * registry is in place.
   */
  enable(): MetricsRegistry {
    if (this.registry instanceof NoopMetricsRegistry) {
      this.registry = new DefaultMetricsRegistry();
    }
    return this.registry;
  }

  /**
   * Plug in a custom registry — useful when you want to share a
   * single registry across multiple `ActorSystem`s (rare) or to
   * instrument with a third-party Prom client library directly.
   */
  useRegistry(registry: MetricsRegistry): void {
    this.registry = registry;
  }

  /** True if a real (non-noop) registry is installed. */
  isEnabled(): boolean {
    return !(this.registry instanceof NoopMetricsRegistry);
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
