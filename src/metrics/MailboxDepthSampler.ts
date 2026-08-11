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
   * that drains can be zeroed exactly once instead of leaving its last deep
   * reading standing forever.  The registry has no per-child removal, so
   * zeroing is the only honest way to say "this actor is no longer behind".
   *
   * The whole tuple is kept, not just the path: a gauge child is keyed by
   * every label, so zeroing with a reconstructed `class` would mint a second
   * series and leave the first standing at its last spike — doubling the
   * cardinality this sampler is careful about instead of correcting it.  A
   * terminated actor is gone from the tree by the time it is zeroed, so its
   * class name is no longer derivable and has to have been remembered.
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

  stop(): void {
    this.ticker?.cancel();
    this.ticker = null;
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
        this.registry.gauge('actor_mailbox_size', previous, { help: HELP }).set(0);
      }
      this.reported.set(cell.path, labels);
      this.registry.gauge('actor_mailbox_size', labels, { help: HELP }).set(cell.mailboxSize);
    }
    // Anything previously above the floor and no longer deep — or no longer
    // in the tree at all — reads 0 rather than its last spike.  A terminated
    // actor leaves its series behind at 0, which is the truthful reading: it
    // has no backlog because it has no mailbox.
    for (const [path, labels] of drained) {
      this.reported.delete(path);
      this.registry.gauge('actor_mailbox_size', labels, { help: HELP }).set(0);
    }
  }
}
