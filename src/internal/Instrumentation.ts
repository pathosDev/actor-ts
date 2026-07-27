/**
 * Shapes the runtime exposes for introspection tooling.
 *
 * They live here, in the runtime, rather than in `src/devtools/` so the
 * core never imports the DevTools module: the dependency runs one way
 * only, and a build that drops DevTools still compiles.  Nothing in the
 * runtime reads these types — they exist purely so a tool can describe
 * a live system without reaching into private fields.
 */

/** Lifecycle state of an actor cell. */
export type CellState = 'creating' | 'running' | 'suspended' | 'terminating' | 'terminated';

/** How one message handling finished. */
export type MessageOutcome = 'ok' | 'error' | 'stashed';

/** One recorded message handling — see {@link ExplainRecorder}. */
export interface MessageExplain {
  /** Monotonically increasing per actor, so a gap is visible. */
  readonly sequenceNumber: number;
  /** Wall clock at handler start. */
  readonly atMs: number;
  readonly messageType: string;
  readonly senderPath: string | null;
  /**
   * Time from first enqueue to handler start, or `null` when the
   * envelope was queued before recording began.
   *
   * A stashed message keeps its ORIGINAL stamp when replayed, so stash
   * residency is included here — which is the honest answer to "how
   * long did this message wait?".
   */
  readonly mailboxWaitMs: number | null;
  readonly handleTimeMs: number;
  readonly outcome: MessageOutcome;
  readonly errorMessage: string | null;
  /** Span produced by this handling, for cross-linking into a trace. */
  readonly spanId: string | null;
}

/**
 * Per-actor ring of recent message handlings.
 *
 * Opt-in and per actor: recording every message on every actor would
 * cost more than most of the handlers being measured.  The question it
 * answers — "what has THIS actor been doing?" — is asked about one
 * actor at a time anyway.
 */
export class ExplainRecorder {
  private readonly entries: MessageExplain[] = [];
  private sequenceNumber = 0;

  constructor(readonly capacity: number) {}

  /** Append one handling, evicting the oldest once full. */
  record(entry: Omit<MessageExplain, 'sequenceNumber'>): void {
    this.entries.push({ ...entry, sequenceNumber: ++this.sequenceNumber });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /** Recorded handlings, oldest first. */
  snapshot(): ReadonlyArray<MessageExplain> {
    return [...this.entries];
  }
}

/** One completed message handling, as seen by a profiler. */
export interface DispatchObservation {
  readonly actorPath: string;
  /** Constructor name of the actor instance. */
  readonly className: string;
  readonly messageType: string;
  readonly handleTimeMs: number;
  readonly outcome: MessageOutcome;
}

/**
 * Notified after every message an actor finishes handling.
 *
 * A system holds at most one — profiling is a whole-system activity
 * with a single owner, and a chain of observers on the hottest path in
 * the framework would be a cost nobody asked for.  The observer is
 * called synchronously, so an implementation must be cheap: anything
 * slow belongs in an aggregation the observer feeds, not in the
 * observer itself.
 */
export interface DispatchObserver {
  onMessageProcessed(observation: DispatchObservation): void;
}

/** A point-in-time description of one actor cell. */
export interface CellInspection {
  /** Full path, e.g. `actor-ts://system/user/orders/order-42`. */
  readonly path: string;
  /** Path of the parent, or `null` for the root guardian. */
  readonly parentPath: string | null;
  /** Last path segment. */
  readonly name: string;
  /** Constructor name of the actor instance, or `'?'` before creation. */
  readonly className: string;
  readonly cellState: CellState;
  /** Pending user messages. */
  readonly mailboxSize: number;
  readonly stashSize: number;
  readonly suspended: boolean;
  /** Dispatcher id, or `null` when the cell uses the system default. */
  readonly dispatcher: string | null;
  readonly childCount: number;
}
