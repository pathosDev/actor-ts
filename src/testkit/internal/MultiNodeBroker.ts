import type { NodeAddress } from '../../cluster/NodeAddress.js';
import { NodeAddress as NodeAddressConstructor } from '../../cluster/NodeAddress.js';
import {
  isBrokeredMessage,
  type PortLike,
} from '../../cluster/transports/MessageChannelTransport.js';
import { withChannelSource } from '../../worker/WorkerBroker.js';

/**
 * Worker-broker variant for `ParallelMultiNodeSpec` — extends the
 * production `WorkerBroker` semantics with two things tests need:
 *
 *   1. **`partition(a, b)` / `heal(a, b)`** — bidirectionally drop
 *      messages between two registered addresses, simulating a
 *      network partition between worker pairs.  The cluster's
 *      failure-detector eventually marks the unreachable side
 *      `unreachable → down → removed`.
 *
 *   2. **`unregisterAndDropFutureFrames(addr)`** — used by `crash()`
 *      to make sure any in-flight frames from the dying worker are
 *      not delivered after the crash.
 *
 * We don't subclass the production broker because the broker's
 * routing logic is small enough to fork cleanly here, and the
 * production version doesn't need the test-only hooks.  Keeps the
 * production code path lean.
 */
export class MultiNodeBroker {
  private readonly ports = new Map<string, PortLike>();
  /** Set of `"a→b"` strings — directed; we add both directions to
   *  represent a bidirectional partition.  Frames targeting a
   *  blocked direction get dropped silently. */
  private readonly blocked = new Set<string>();
  private stopped = false;

  register(address: NodeAddress, port: PortLike): void {
    const key = address.toString();
    if (this.ports.has(key)) {
      throw new Error(`MultiNodeBroker: address ${key} already registered`);
    }
    this.ports.set(key, port);
    port.onmessage = (evt) => this.onMessage(address, evt.data);
    port.start?.();
  }

  unregister(address: NodeAddress): void {
    const key = address.toString();
    const port = this.ports.get(key);
    if (!port) return;
    try { port.onmessage = null; } catch { /* ignore */ }
    try { port.close?.(); } catch { /* ignore */ }
    this.ports.delete(key);
  }

  close(): void {
    this.stopped = true;
    for (const [, port] of this.ports) {
      try { port.onmessage = null; } catch { /* ignore */ }
      try { port.close?.(); } catch { /* ignore */ }
    }
    this.ports.clear();
    this.blocked.clear();
  }

  /** Register a bidirectional partition between `a` and `b`. */
  partition(a: NodeAddress, b: NodeAddress): void {
    this.blocked.add(`${a}→${b}`);
    this.blocked.add(`${b}→${a}`);
  }

  /** Lift the partition between `a` and `b`. */
  heal(a: NodeAddress, b: NodeAddress): void {
    this.blocked.delete(`${a}→${b}`);
    this.blocked.delete(`${b}→${a}`);
  }

  registered(): NodeAddress[] {
    return Array.from(this.ports.keys()).map((k) => NodeAddressConstructor.parse(k));
  }

  /* -------------------------------- internals ------------------------- */

  /**
   * `withChannelSource` is imported from the production broker rather than
   * re-implemented, and that is the whole point of importing it: a harness
   * that let a scenario forge `from` where production rewrites it would make
   * `ParallelMultiNodeSpec` disagree with the mesh it stands in for, in the
   * one direction that matters — a scenario passing here and failing in a real
   * worker mesh (#774).  Nothing is lost for tests that *want* to speak as
   * someone else: `Cluster.handleWire` is reachable directly, which is how
   * `tests/multi-node/ClusterSecurity.test.ts` injects every frame it forges.
   *
   * `isBrokeredMessage` is imported for the same reason and settles the same
   * disagreement one field earlier.  `frame` is `unknown` because it is whatever
   * a worker put on its port; the `BrokeredMessage` cast this signature used to
   * carry made `NodeAddressConstructor.fromJSON(frame.to)` a bare dereference,
   * which since #571 does not merely mis-route a malformed address but *throws*
   * — inside the harness's own `message` listener, where nothing catches it, so
   * one bad frame from one worker takes the whole test process down with it
   * (#701).  That is the defect the production broker was fixed for; this fork
   * kept it, and no suite named this file to notice.
   *
   * The try/catch is the same backstop production has, and here it also swallows
   * the teardown race `docs/…/testing/diagnosing-flakes.mdx` records: forwarding
   * to a worker that `crash()` already terminated throws `InvalidStateError` out
   * of `postMessage`, which used to surface as a failure of whichever test
   * happened to be running.  A terminated peer is an unroutable destination, and
   * unroutable destinations have always been dropped here.  The race itself is
   * unchanged — only its escalation into an unrelated test's failure is gone.
   */
  private onMessage(source: NodeAddress, frame: unknown): void {
    if (this.stopped) return;
    const sourceKey = source.toString();
    if (!this.ports.has(sourceKey)) return;     // sender was unregistered
    if (!isBrokeredMessage(frame)) return;      // malformed → drop, never throw
    try {
      const targetAddress = NodeAddressConstructor.fromJSON(frame.to);
      const targetKey = targetAddress.toString();
      if (this.blocked.has(`${sourceKey}→${targetKey}`)) return;  // partition
      const target = this.ports.get(targetKey);
      if (!target) return;                      // unknown destination
      target.postMessage(withChannelSource(frame, source));
    } catch { /* malformed or unroutable → drop */ }
  }
}
