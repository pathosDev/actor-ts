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
