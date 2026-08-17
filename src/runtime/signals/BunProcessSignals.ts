import { NodeProcessSignals } from './NodeProcessSignals.js';
import type { ProcessSignals } from './ProcessSignals.js';

/**
 * Bun's signal delivery — Node's `process` event API, implemented verbatim.
 *
 * The subclass carries no behaviour on purpose.  It exists so the registry
 * has one class per runtime, so a stack trace and `runtime` name the real
 * host, and so a future Bun-only divergence has somewhere to land that is
 * not an `if` inside the Node backend.  Sharing the implementation rather
 * than copying it is the point: the two really are the same API, and a
 * duplicated copy is how the two halves of a pair drift apart unnoticed.
 */
export class BunProcessSignals extends NodeProcessSignals {
  override readonly runtime: ProcessSignals['runtime'] = 'Bun';
}
