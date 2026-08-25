/**
 * `actor_mailbox_size` — per-actor mailbox depth, sampled on a timer.
 *
 * The tuning docs have described this gauge for as long as they have
 * existed; nothing ever emitted it.  #1148 is what makes the omission
 * expensive: with the default mailbox unbounded again,
 * `actor_mailbox_dropped_total` only counts drops from mailboxes someone
 * bounded deliberately, so depth is the signal that a slow consumer is
 * accumulating rather than losing.
 *
 * Sampled, not hooked into `enqueue`.  Depth changes on the framework's
 * hottest path, and the question the gauge answers is about an instant
 * rather than a rate, so a tree walk on a timer costs nothing where it
 * matters and reads the same value a scrape would.  `MailboxSamplerTap` in
 * DevTools takes the same shape for the same reason.
 */
import type { ActorSystem } from '../ActorSystem.js';
import type { Cancellable } from '../Scheduler.js';
import type { MetricsRegistry } from './Metrics.js';
import {
  DEFAULT_MAILBOX_DEPTH_SAMPLE_INTERVAL_MS,
  MAILBOX_DEPTH_REPORTING_FLOOR,
} from './Constants.js';

const HELP = 'Queued user messages per actor, sampled. '
  + 'Only actors at or above the reporting floor are represented.';

export class MailboxDepthSampler {
  private ticker: Cancellable | null = null;
  /**
   * Label tuples that currently carry a series, keyed by path, so a mailbox
   * that drains has its series removed exactly once instead of leaving its
   * last deep reading standing forever.
   *
   * This used to zero the series instead, because the registry had no
   * per-child removal (#745).  `MetricsRegistry.remove` is what a drained
   * mailbox deserves: a gauge reading 0 asserts that the actor exists and
   * has no backlog, which for a *terminated* actor is a claim about
   * something that is not there, and it kept the tuple — and its slot under
   * the cardinality cap — for the life of the process.  An absent series
   * says "not reporting", which is exactly the truth.
   *
   * The map itself stays. The registry exposes no way to enumerate a
   * family's children, so this is the only record of which paths currently
   * carry a series; and the whole tuple is kept, not just the path, because
   * a child is keyed by every label — a terminated actor is gone from the
   * tree by the time it is retired, so its class name is no longer
   * derivable and has to have been remembered.
   */
  private readonly reported = new Map<string, { class: string; path: string }>();

  constructor(
    private readonly system: ActorSystem,
    private readonly registry: MetricsRegistry,
    private readonly intervalMs: number = DEFAULT_MAILBOX_DEPTH_SAMPLE_INTERVAL_MS,
    private readonly floor: number = MAILBOX_DEPTH_REPORTING_FLOOR,
  ) {}

  start(): void {
    if (this.ticker !== null) return;
    this.ticker = this.system.scheduler.scheduleAtFixedRateFunction(
      this.intervalMs,
      this.intervalMs,
      () => this.sample(),
    );
  }

  /**
   * Stop sampling and retire everything this sampler minted.
   *
   * The removal is not merely tidiness: `reported` is the only record of
   * which tuples are live, so a `stop()` that forgot it without removing
   * would strand every series it had minted in a registry that outlives the
   * sampler — `MetricsExtension.useRegistry` stops one while the old
   * registry is still installed, and a restarted sampler starts from an
   * empty map and could never reach them again.
   */
  stop(): void {
    this.ticker?.cancel();
    this.ticker = null;
    for (const labels of this.reported.values()) {
      this.registry.remove('actor_mailbox_size', labels);
    }
    this.reported.clear();
  }

  /**
   * One pass over the tree.  Public so a test — or an exporter that wants a
   * reading fresher than the tick — can force one without waiting.
   */
  sample(): void {
    const drained = new Map(this.reported);
    for (const cell of this.system._inspectTree()) {
      if (cell.mailboxSize < this.floor) continue;
      drained.delete(cell.path);
      const labels = { class: cell.className, path: cell.path };
      // A path's class label is not fixed for the cell's life: `className`
      // reads `'?'` until the actor instance exists, so a cell flooded
      // before its `create` message is handled reports one tuple and then a
      // different one.  Retiring the old tuple keeps the invariant that a
      // path has at most one live series — without this the `'?'` reading
      // would stand at its spike forever with the real one beside it.
      const previous = this.reported.get(cell.path);
      if (previous !== undefined && previous.class !== labels.class) {
        this.registry.remove('actor_mailbox_size', previous);
      }
      this.reported.set(cell.path, labels);
      this.registry.gauge('actor_mailbox_size', labels, { help: HELP }).set(cell.mailboxSize);
    }
    // Anything previously above the floor and no longer deep — or no longer
    // in the tree at all — loses its series rather than standing at its last
    // spike.  Removal rather than a 0 reading: this family's whole contract
    // is that a series exists only for an actor that is *already* deeply
    // backlogged, so on a healthy system it is empty — and a drained actor
    // is a healthy one.  It also gives the actor's slot under the
    // cardinality cap back, which is what keeps the family's width the
    // count of concurrent incidents rather than of incidents ever had.
    for (const [path, labels] of drained) {
      this.reported.delete(path);
      this.registry.remove('actor_mailbox_size', labels);
    }
  }
}
