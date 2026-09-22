import { MAX_KNOWN_CHANNEL_PEERS } from '../Constants.js';
import { NodeAddress } from '../NodeAddress.js';
import type { WireMessage } from '../Protocol.js';
import type { Transport, WireHandler } from '../Transport.js';
import { isNodeAddressData, validateWireFrame } from '../WireValidation.js';

/**
 * Message shape carried over the underlying MessageChannel.  The broker
 * pattern means every outbound frame from a worker includes the sender
 * address (so the receiver can put it in `WireHandler`) and the intended
 * recipient (so the broker can route it).
 */
export type BrokeredMessage = {
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly to: ReturnType<NodeAddress['toJSON']>;
  readonly payload: WireMessage;
};

/**
 * The floor a brokered envelope must clear before anything reads it.
 *
 * Only the two address fields are checked: `to` is what a broker dereferences
 * to route the frame, and `from` is what the receiving
 * {@link MessageChannelTransport} dereferences the moment the frame is
 * re-posted.  The `payload` is not validated here: `onFrame` runs
 * `validateWireFrame` over it one step later (#945), and doing it in both
 * places would mean two guards to keep in step.
 *
 * It lives beside {@link BrokeredMessage} rather than inside a broker because
 * there are two brokers — `WorkerBroker` in production and the testkit's
 * `MultiNodeBroker` — and a guard copied into both is a guard that drifts.  That
 * is not hypothetical: the testkit fork kept the unguarded shape right through
 * #701's first fix, and nothing noticed because until then no suite named it.
 * `src/worker/` is not an option for the shared home the way `withChannelSource`
 * is: the third caller is {@link MessageChannelTransport.onFrame} itself, and
 * `src/cluster/` importing from `src/worker/` would invert the layering both
 * brokers already depend on.
 */
export function isBrokeredMessage(value: unknown): value is BrokeredMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { to, from } = value as Partial<BrokeredMessage>;
  return isNodeAddressData(to) && isNodeAddressData(from);
}

/**
 * MessagePort-like minimal surface — we only use these three members so
 * the transport works equally well with browser `MessagePort`,
 * Node/Bun `worker_threads.MessagePort`, or any in-process shim used by
 * tests.
 */
export interface PortLike {
  postMessage(value: unknown, transfer?: unknown[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close?(): void;
  start?(): void;
}

/**
 * Transport that talks to the rest of the cluster through a single pair of
 * `MessagePort`s — this node holds one end; a broker (typically the
 * main-thread `WorkerCluster`) holds the other end of every worker and
 * forwards traffic based on the envelope's `to` address.  Use this to
 * build a multi-core cluster inside one process without paying the TCP
 * overhead.
 */
export class MessageChannelTransport implements Transport {
  readonly self: NodeAddress;
  private readonly port: PortLike;
  private handler: WireHandler = () => {};
  private running = false;
  /**
   * The senders {@link peers} reports, keyed on the string form because that is
   * what identity is here — and holding the {@link NodeAddress} itself because
   * that is what {@link peers} owes its caller.
   *
   * A `Set<string>` re-parsed in `peers()`, which is what this was, made the
   * round trip through `toString`/`parse` part of the transport's contract, and
   * that round trip is lossy for anything `parse` reads differently from what
   * `toString` wrote (#1515).  `NodeAddress.isPort` closes the wire side of
   * that; keeping the recorded object closes the parse side, and it is what
   * `TcpTransport.byPeer` already does.
   */
  private readonly knownPeers = new Map<string, NodeAddress>();

  constructor(self: NodeAddress, port: PortLike) {
    this.self = self;
    this.port = port;
  }

  setHandler(handler: WireHandler): void { this.handler = handler; }

  async start(): Promise<void> {
    this.running = true;
    this.port.onmessage = (evt) => this.onFrame(evt.data);
    this.port.start?.();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.port.onmessage = null;
    try { this.port.close?.(); } catch { /* ignore */ }
  }

  send(to: NodeAddress, message: WireMessage): void {
    if (!this.running) return;
    const envelope: BrokeredMessage = {
      from: this.self.toJSON(),
      to: to.toJSON(),
      payload: message,
    };
    this.port.postMessage(envelope);
  }

  disconnect(_peer: NodeAddress): void {
    // In the broker model we don't own per-peer connections.  Nothing to do.
  }

  peers(): NodeAddress[] {
    return Array.from(this.knownPeers.values());
  }

  /* -------------------------------- Internal ------------------------------- */

  /**
   * The inbound edge, and the reason it is the same three steps `TcpTransport`
   * and `InMemoryTransport` take: the guarantee belongs to the {@link Transport}
   * contract, not to one implementation of it, and this was the implementation
   * that had none of it (#945).
   *
   * `env` is `unknown` rather than {@link BrokeredMessage} for the reason
   * `WorkerBroker.onMessage` states one hop away — it is whatever somebody
   * posted on the port, and the cast this signature used to carry was the
   * defect itself.  A `MessagePort`'s `onmessage` callback has no caller to
   * unwind into on any runtime this framework targets, so an escaping throw is
   * an uncaught top-level error: the host thread, the main-thread actor system
   * and every sibling worker die with it.  That is the whole of the exploit,
   * and it costs one `postMessage`.
   *
   * Three steps, each closing a different route out:
   *
   * 1. {@link isBrokeredMessage} — the envelope's own shape, which is what
   *    `NodeAddress.fromJSON` throws on.  It is the same guard both brokers
   *    spend (#701), and running it here is what makes the transport safe when
   *    there is no broker in between: two of these can be wired port-to-port,
   *    which is exactly how the manual mesh in `worker-mesh.mdx` does it.  Once
   *    it passes, `fromJSON` agrees with it on every *value* — both spend
   *    `NodeAddress.isPort` and `NodeAddress.isIncarnation`, which is where the
   *    two field rules with any substance to them live, so there is one rule
   *    rather than two that agree.  They *were* two: the port half was written
   *    out on both sides and drifted from what `toString` can carry, which is
   *    what #1515 closed.
   *
   *    Agreeing on every value is still not "cannot throw", which is what this
   *    read used to claim, and the gap is that the guard and `fromJSON` are two
   *    *reads* of the same field.  A `from` whose `port` is an accessor
   *    answering `2552` to the first and `1e21` to the second passes the guard
   *    and throws out of `fromJSON` — outside the `try` below, which only ever
   *    wrapped the handler, so straight out of the `onmessage` callback.  A
   *    real `MessagePort` structured-clones the envelope and strips accessors,
   *    but this class takes any {@link PortLike} and is exported package
   *    surface; the testkit's broker and every port-to-port wiring pass the
   *    object itself.  So `fromJSON` gets a `try` of its own, and the refusal
   *    is the same one step 1 would have made.  Keeping it separate from the
   *    handler's `try` is deliberate: a refused envelope and a handler nobody
   *    understands are different failures, and one `catch` over both would say
   *    so nowhere.
   * 2. {@link validateWireFrame} — the payload, which is what every handler
   *    below `Cluster.handleWire` reads as if its declared type were true.  A
   *    gossip frame carrying a member `status` outside the legal set is
   *    refused by the other two transports and used to arrive here intact
   *    (#563), so the guarantees #563, #705 and #711 established for the wire
   *    simply did not hold on the multi-core path.
   * 3. the `try`/`catch` — a handler that throws for a reason nobody
   *    anticipated.  Dropping mirrors closing the connection; there is no
   *    socket to close.
   */
  private onFrame(env: unknown): void {
    if (!this.running) return;
    if (!isBrokeredMessage(env)) return;
    const checked = validateWireFrame(env.payload);
    if ('problem' in checked) return;
    let from: NodeAddress;
    try {
      from = NodeAddress.fromJSON(env.from);
    } catch {
      /* Step 1a — see the JSDoc: the guard's read and this one are two reads. */
      return;
    }
    this.rememberPeer(from);
    try {
      this.handler(from, checked.message);
    } catch {
      /* Mirrors dropping the connection; there is no socket to close. */
    }
  }

  /**
   * Record a peer for {@link peers}, unless {@link MAX_KNOWN_CHANNEL_PEERS} is
   * already full — see that constant for why the newest is refused rather than
   * the oldest evicted.
   *
   * That the cap can never turn an established peer into an unknown one — which
   * matters, because the readiness check reads this map — is a property of the
   * map and not of anything written here: `set` on a key already present leaves
   * the size alone, so the only thing the cap can refuse is a key the map does
   * not have.  This used to open with a `has` short-circuit stating the
   * invariant as though it enforced it; nothing could observe its removal,
   * because there was nothing there to observe.
   *
   * The *caller's* ordering is what earns this set its bound: {@link onFrame}
   * validates the payload before it gets here, so a sender that never posts a
   * legal frame never takes a slot — see
   * `tests/unit/cluster/TransportFrameGuardContract.test.ts`.
   */
  private rememberPeer(from: NodeAddress): void {
    if (this.knownPeers.size >= MAX_KNOWN_CHANNEL_PEERS) return;
    this.knownPeers.set(from.toString(), from);
  }
}
