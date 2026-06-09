import type { NodeAddress } from '../../cluster/NodeAddress.js';
import { NodeAddress as NodeAddressCtor } from '../../cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../../cluster/transports/MessageChannelTransport.js';

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

  /**
   * TEMP diagnostic counters (#flaky-ci) — frame flow through the broker.
   * If `recv` stays ~0 the workers never gossip (worker→broker transport
   * dead); if `recv` climbs but `delivered` lags, routing is dropping
   * frames.  Read by ParallelMultiNodeSpec's awaitMembers debug log.
   */
  readonly stats = {
    recv: 0, delivered: 0,
    dropStopped: 0, dropSenderGone: 0, dropPartition: 0, dropNoTarget: 0,
  };

  register(address: NodeAddress, port: PortLike): void {
    const key = address.toString();
    if (this.ports.has(key)) {
      throw new Error(`MultiNodeBroker: address ${key} already registered`);
    }
    this.ports.set(key, port);
    port.onmessage = (evt) => this.onMessage(key, evt.data as BrokeredMessage);
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
    return Array.from(this.ports.keys()).map((k) => NodeAddressCtor.parse(k));
  }

  /* -------------------------------- internals ------------------------- */

  private onMessage(sourceKey: string, env: BrokeredMessage): void {
    this.stats.recv++;
    if (this.stopped) { this.stats.dropStopped++; return; }
    if (!this.ports.has(sourceKey)) { this.stats.dropSenderGone++; return; }     // sender was unregistered
    const targetAddr = NodeAddressCtor.fromJSON(env.to);
    const targetKey = targetAddr.toString();
    if (this.blocked.has(`${sourceKey}→${targetKey}`)) { this.stats.dropPartition++; return; }  // partition
    const target = this.ports.get(targetKey);
    if (!target) { this.stats.dropNoTarget++; return; }                        // unknown destination
    this.stats.delivered++;
    target.postMessage(env);
  }
}
