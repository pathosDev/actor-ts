import { NodeAddress } from '../cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';

/**
 * Main-thread piece of the multi-core cluster.  Collects one `MessagePort`
 * per worker and forwards `BrokeredMessage`s based on their `to` address.
 * Unknown destinations are dropped silently — the rest of the cluster
 * deals with them through the normal dead-letters / failure-detection
 * paths.
 *
 * The broker itself does not speak the cluster gossip protocol; it is
 * purely a routing layer between worker transports.
 */
export class WorkerBroker {
  private readonly ports = new Map<string, PortLike>();
  private stopped = false;

  /**
   * Register a worker's port — the broker will forward to its peers from
   * now on and accept inbound traffic from it.
   */
  register(address: NodeAddress, port: PortLike): void {
    const key = address.toString();
    if (this.ports.has(key)) throw new Error(`WorkerBroker: address ${key} already registered`);
    this.ports.set(key, port);
    port.onmessage = (evt) => this.onMessage(key, evt.data as BrokeredMessage);
    port.start?.();
  }

  /** Drop a worker's port (typically on worker shutdown). */
  unregister(address: NodeAddress): void {
    const key = address.toString();
    const port = this.ports.get(key);
    if (!port) return;
    try { port.onmessage = null; } catch { /* ignore */ }
    try { port.close?.(); } catch { /* ignore */ }
    this.ports.delete(key);
  }

  /** Close every port; further messages are dropped. */
  close(): void {
    this.stopped = true;
    for (const [, port] of this.ports) {
      try { port.onmessage = null; } catch { /* ignore */ }
      try { port.close?.(); } catch { /* ignore */ }
    }
    this.ports.clear();
  }

  /** Snapshot of currently-registered addresses — diagnostic only. */
  registered(): NodeAddress[] {
    return Array.from(this.ports.keys()).map(k => NodeAddress.parse(k));
  }

  /* -------------------------------- Internal ------------------------------- */

  private onMessage(_sourceKey: string, env: BrokeredMessage): void {
    if (this.stopped) return;
    const targetAddr = NodeAddress.fromJSON(env.to);
    const target = this.ports.get(targetAddr.toString());
    if (!target) return;                       // unknown address → drop
    // Re-post verbatim; receiver's transport trusts the envelope's `from`.
    target.postMessage(env);
  }
}
