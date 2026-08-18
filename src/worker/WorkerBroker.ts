import { NodeAddress } from '../cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import { isNodeAddressData } from '../cluster/WireValidation.js';

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
    // A closed broker must stay empty.  Without this a respawn that raced
    // shutdown re-populated `ports` after `close()` with a port whose traffic
    // `onMessage` then drops — inert, permanently retained, and keeping its
    // worker reachable-but-dead for the process lifetime (#735).
    if (this.stopped) {
      try { port.close?.(); } catch { /* ignore */ }
      return;
    }
    if (this.ports.has(key)) throw new Error(`WorkerBroker: address ${key} already registered`);
    this.ports.set(key, port);
    port.onmessage = (evt) => this.onMessage(key, evt.data);
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

  /**
   * `frame` is `unknown` and not `BrokeredMessage` deliberately — it is
   * whatever a worker put on its port, and the cast this signature used to
   * carry was the whole defect.  `NodeAddress.fromJSON` validates and
   * *throws* by design (#571), on the premise that a frame guard rejected
   * malformed addresses before it ran; that premise never held here, so the
   * hardening turned a class of malformed frame that used to be routed or
   * silently dropped into a host-killing throw inside the worker's `message`
   * listener (#701).
   *
   * Malformed frames are dropped, not rejected loudly: this is the same policy
   * the unknown-destination case has always had, and the broker has no logger
   * to report through.  The try/catch is a backstop for the same reason — a
   * throw from anything downstream must not escape into an event callback the
   * host cannot catch.
   */
  private onMessage(_sourceKey: string, frame: unknown): void {
    if (this.stopped) return;
    if (!isBrokeredMessage(frame)) return;
    try {
      const targetAddr = NodeAddress.fromJSON(frame.to);
      const target = this.ports.get(targetAddr.toString());
      if (!target) return;                     // unknown address → drop
      // Re-post verbatim; receiver's transport trusts the envelope's `from`.
      target.postMessage(frame);
    } catch { /* malformed or unroutable → drop */ }
  }
}

/**
 * The floor a brokered envelope must clear before anything reads it.
 *
 * Only the two address fields are checked: `to` is what the broker itself
 * dereferences, and `from` is what the receiving `MessageChannelTransport`
 * dereferences the moment the frame is re-posted.  The `payload` is not
 * validated here — that is #945's brief, over on the transport, and doing it in
 * both places would mean two guards to keep in step.
 */
function isBrokeredMessage(value: unknown): value is BrokeredMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { to, from } = value as Partial<BrokeredMessage>;
  return isNodeAddressData(to) && isNodeAddressData(from);
}
