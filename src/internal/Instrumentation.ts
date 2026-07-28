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

/** Longest JSON a captured message may occupy, in characters. */
const MESSAGE_JSON_LIMIT = 2_000;
/** How deep {@link describeMessagePayload} walks before giving up. */
const MESSAGE_JSON_DEPTH = 6;

/**
 * A name for a message, for tooling that lists what an actor handled.
 *
 * `constructor.name` alone answers `'Object'` for every plain object,
 * which is most messages in this codebase — the house convention is a
 * `kind`-discriminated union of object literals, so the discriminant is
 * the name a developer would give it.  Classes keep their own name.
 */
export function describeMessageType(message: unknown): string {
  if (message === null || message === undefined) return typeof message;
  // A primitive keeps its wrapper's name (`String`, `Number`), which is
  // what this reported before and reads like the type names around it.
  if (typeof message !== 'object') {
    return (message as { constructor?: { name?: string } }).constructor?.name ?? typeof message;
  }
  const kind = (message as { kind?: unknown }).kind;
  const constructorName = (message as { constructor?: { name?: string } }).constructor?.name;
  if (typeof kind === 'string' && kind.length > 0) {
    // A tagged class carries both; showing them together beats choosing.
    return constructorName === undefined || constructorName === 'Object'
      ? kind
      : `${constructorName}.${kind}`;
  }
  return constructorName ?? 'object';
}

/**
 * A message as JSON, safe to put on a wire and into a table cell.
 *
 * Bounded on three axes because the input is arbitrary user data: depth,
 * total length, and anything `JSON.stringify` refuses (a cycle, a
 * BigInt).  Returns `null` rather than throwing — a message nobody can
 * serialise must not break the dispatch it is describing.
 */
export function describeMessagePayload(message: unknown): string | null {
  try {
    const json = JSON.stringify(message, replacer(MESSAGE_JSON_DEPTH));
    if (json === undefined) return null;
    return json.length > MESSAGE_JSON_LIMIT
      ? `${json.slice(0, MESSAGE_JSON_LIMIT)}… (truncated)`
      : json;
  } catch {
    return null;
  }
}

/** Replaces what JSON cannot carry, and stops runaway nesting. */
function replacer(maxDepth: number): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  const depths = new WeakMap<object, number>();
  return function replace(this: unknown, key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const parentDepth = typeof this === 'object' && this !== null ? depths.get(this) ?? 0 : 0;
    const depth = key === '' ? 0 : parentDepth + 1;
    if (depth > maxDepth) return '[…]';
    depths.set(value, depth);
    return value;
  };
}

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
  /** Tooling actor — see `PropsConfig.internal`.  Inherited from the parent. */
  readonly internal: boolean;
}
