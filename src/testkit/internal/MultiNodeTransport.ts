import type { NodeAddress } from '../../cluster/NodeAddress.js';
import { NodeAddress as NodeAddressConstructor } from '../../cluster/NodeAddress.js';
import type { WireMessage } from '../../cluster/Protocol.js';
import type { Transport, WireHandler } from '../../cluster/Transport.js';

/**
 * In-process Transport with per-instance partition controls — the
 * backbone of `MultiNodeSpec`.
 *
 * Looks just like `InMemoryTransport` (process-global registry,
 * microtask-deferred delivery so ordering mirrors TCP), with two
 * extras the multi-node test harness needs:
 *
 *   1. **Outbound block set** — `blockOutgoing(peer)` makes this
 *      transport refuse to send to a specific peer.  Combined with
 *      the receiving side's mirror check, that is a one-way "drop"
 *      from this side's perspective.
 *   2. **Bidirectional partition** — `partitionFromPeer(peer)`
 *      blocks both directions between this node and `peer`,
 *      simulating a real network partition.  `heal(peer)` undoes it.
 *
 * Used only by tests; do NOT export this from the package barrel —
 * production code should use `InMemoryTransport` (no partition hooks)
 * or `TcpTransport` / `MessageChannelTransport`.
 */
export class MultiNodeTransport implements Transport {
  private static registry = new Map<string, MultiNodeTransport>();

  private handler: WireHandler = () => { /* no-op */ };
  private stopped = false;
  private readonly blockedOutgoing = new Set<string>();

  constructor(readonly self: NodeAddress) {}

  setHandler(handler: WireHandler): void { this.handler = handler; }

  async start(): Promise<void> {
    MultiNodeTransport.registry.set(this.self.toString(), this);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    MultiNodeTransport.registry.delete(this.self.toString());
  }

  send(to: NodeAddress, message: WireMessage): void {
    if (this.stopped) return;
    const toKey = to.toString();
    if (this.blockedOutgoing.has(toKey)) return;
    const peer = MultiNodeTransport.registry.get(toKey);
    if (!peer || peer.stopped) return;
    // Mirror — if the peer has us in its outgoing-block set, that
    // means the partition is bidirectional; drop on its side too.
    if (peer.blockedOutgoing.has(this.self.toString())) return;
    const from = this.self;
    queueMicrotask(() => {
      if (!peer.stopped) peer.handler(from, message);
    });
  }

  disconnect(_peer: NodeAddress): void { /* stateless registry */ }

  peers(): NodeAddress[] {
    return Array.from(MultiNodeTransport.registry.keys())
      .filter((k) => k !== this.self.toString())
      .map((k) => NodeAddressConstructor.parse(k));
  }

  /* ---------------------------- partition controls --------------------------- */

  /** Block all outgoing traffic from this transport to `peer`. */
  blockOutgoing(peer: NodeAddress): void {
    this.blockedOutgoing.add(peer.toString());
  }

  /** Undo `blockOutgoing` for `peer`. */
  unblockOutgoing(peer: NodeAddress): void {
    this.blockedOutgoing.delete(peer.toString());
  }

  /**
   * Bidirectional partition: this transport refuses outgoing to `peer`,
   * and (by virtue of `send`'s mirror check) any frame from this side
   * that the peer might still attempt to route to us is dropped on the
   * peer's side too.  In effect: a network partition between the two.
   *
   * Note: the symmetric call must be made on the *peer*'s transport
   * for the partition to take effect in both directions explicitly —
   * this method only updates *this* transport's view.  Use
   * `MultiNodeSpec.partition(roleA, roleB)` for the symmetric helper.
   */
  partitionFromPeer(peer: NodeAddress): void {
    this.blockOutgoing(peer);
  }

  /** True iff currently blocked from sending to `peer`. */
  isPartitionedFrom(peer: NodeAddress): boolean {
    return this.blockedOutgoing.has(peer.toString());
  }

  /** Test reset — clears the registry.  Intended for `afterEach`. */
  static _resetRegistryForTest(): void {
    MultiNodeTransport.registry.clear();
  }
}
