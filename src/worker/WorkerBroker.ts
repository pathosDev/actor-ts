import { NodeAddress } from '../cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import { isNodeAddressData } from '../cluster/WireValidation.js';

/**
 * Main-thread piece of the multi-core cluster.  Collects one `MessagePort`
 * per worker and forwards `BrokeredMessage`s based on their `to` address,
 * re-addressing each to the port it arrived on ({@link withChannelSource}).
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
    // The `NodeAddress` and not `key`: `onMessage` stamps this address into
    // every frame the port sends (#774), and parsing it back out of the string
    // form per frame would redo work the registration already did.
    port.onmessage = (evt) => this.onMessage(address, evt.data);
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
   *
   * `source` is the address this port was registered under — the one identity
   * on this path a worker cannot choose for itself, because the host minted it
   * (`WorkerCluster.spawnOne`) and handed it to {@link WorkerBroker.register}.
   * {@link withChannelSource} is what spends it (#774).
   */
  private onMessage(source: NodeAddress, frame: unknown): void {
    if (this.stopped) return;
    if (!isBrokeredMessage(frame)) return;
    try {
      const targetAddress = NodeAddress.fromJSON(frame.to);
      const target = this.ports.get(targetAddress.toString());
      if (!target) return;                     // unknown address → drop
      target.postMessage(withChannelSource(frame, source));
    } catch { /* malformed or unroutable → drop */ }
  }
}

/**
 * Re-address a frame to the port it actually arrived on (#774).
 *
 * The broker holds a binding no worker can forge, and used to throw it away:
 * it re-posted whatever `from` the sender wrote, and the receiving
 * `MessageChannelTransport` hands that value straight to `Cluster.handleWire`
 * as the peer identity.  So one worker could refresh a sibling's
 * failure-detector timer — keeping a dead node looking alive — and have its
 * envelopes attributed to that sibling.  Every other identity fix in the
 * cluster (#562, #564, #572, #574, #582) takes the peer from the connection
 * rather than from the payload; this is that same rule one layer down, where
 * the connection is a `MessagePort`.
 *
 * Rewriting rather than dropping the mismatch is deliberate.  It makes the
 * receiver's peer identity channel-derived *by construction*, so no later
 * caller can forget a check, and it concedes nothing: the sender is a live
 * registered peer that could have sent the same payload under its own name.
 * It also leaves nothing to report, which matters while `src/worker/` still
 * has no logger to report through (#1276) — a dropped frame would be a
 * silent refusal, where a re-addressed one is simply correct.
 *
 * The equality test is a fast path rather than an optimisation detail.
 * Measured on the broker's own forward loop (2M honest frames, 5 interleaved
 * rounds, 3 repetitions, Bun; `benchmarks/` has no arm over this path): against
 * a ~210 ns baseline, returning the frame unchanged costs nothing measurable —
 * its delta lands at or below zero, inside a run-to-run band of about ±30 ns —
 * while allocating a replacement unconditionally costs ~35-55 ns, and the drop
 * variant the issue also proposed —
 * `NodeAddress.fromJSON(frame.from).toString() !== source.toString()` — costs
 * ~210-240 ns, i.e. it roughly doubles the cost of forwarding a frame.
 *
 * Only the *slot* is compared, because the slot is the identity: `toString`,
 * `equals` and `compareTo` all exclude {@link NodeAddress.incarnation} by
 * design, so the failure detector, every member map and every authority rule
 * key on `systemName@host:port` alone.  A sender may therefore still choose
 * the `incarnation` it writes into `from`, which is harmless only for as long
 * as that field stays carried-but-not-acted-on (#940); the merge rule that
 * first keys on it has to bring this comparison with it.
 *
 * Exported for the testkit's broker fork alone — `src/testkit/internal/
 * MultiNodeBroker.ts` routes `ParallelMultiNodeSpec`'s worker mesh and has to
 * apply the identical rule, and a copied six-liner is a copy that drifts.  It
 * is not in `src/worker/index.ts`, so it is not package surface.
 */
export function withChannelSource(frame: BrokeredMessage, source: NodeAddress): BrokeredMessage {
  const { from } = frame;
  if (from.systemName === source.systemName
    && from.host === source.host
    && from.port === source.port) {
    return frame;
  }
  return { ...frame, from: source.toJSON() };
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
