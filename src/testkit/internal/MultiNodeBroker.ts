import type { NodeAddress } from '../../cluster/NodeAddress.js';
import { NodeAddress as NodeAddressConstructor } from '../../cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
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
    port.onmessage = (evt) => this.onMessage(address, evt.data as BrokeredMessage);
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
   */
  private onMessage(source: NodeAddress, env: BrokeredMessage): void {
    if (this.stopped) return;
    const sourceKey = source.toString();
    if (!this.ports.has(sourceKey)) return;     // sender was unregistered
    const targetAddress = NodeAddressConstructor.fromJSON(env.to);
    const targetKey = targetAddress.toString();
    if (this.blocked.has(`${sourceKey}→${targetKey}`)) return;  // partition
    const target = this.ports.get(targetKey);
    if (!target) return;                        // unknown destination
    target.postMessage(withChannelSource(env, source));
  }
}
