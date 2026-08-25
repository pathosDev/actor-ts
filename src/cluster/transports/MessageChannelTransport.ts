import { NodeAddress } from '../NodeAddress.js';
import type { WireMessage } from '../Protocol.js';
import type { Transport, WireHandler } from '../Transport.js';
import { isNodeAddressData } from '../WireValidation.js';

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
 * re-posted.  The `payload` is not validated here — that is #945's brief, over
 * on the transport, and doing it in both places would mean two guards to keep
 * in step.
 *
 * It lives beside {@link BrokeredMessage} rather than inside a broker because
 * there are two brokers — `WorkerBroker` in production and the testkit's
 * `MultiNodeBroker` — and a guard copied into both is a guard that drifts.  That
 * is not hypothetical: the testkit fork kept the unguarded shape right through
 * #701's first fix, and nothing noticed because until then no suite named it.
 * `src/worker/` is not an option for the shared home the way `withChannelSource`
 * is: the third prospective caller is {@link MessageChannelTransport.onFrame}
 * itself (#945), and `src/cluster/` importing from `src/worker/` would invert
 * the layering both brokers already depend on.
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
  private readonly knownPeers = new Set<string>();

  constructor(self: NodeAddress, port: PortLike) {
    this.self = self;
    this.port = port;
  }

  setHandler(handler: WireHandler): void { this.handler = handler; }

  async start(): Promise<void> {
    this.running = true;
    this.port.onmessage = (evt) => this.onFrame(evt.data as BrokeredMessage);
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
    return Array.from(this.knownPeers).map(s => NodeAddress.parse(s));
  }

  /* -------------------------------- Internal ------------------------------- */

  private onFrame(env: BrokeredMessage): void {
    if (!this.running) return;
    const from = NodeAddress.fromJSON(env.from);
    this.knownPeers.add(from.toString());
    this.handler(from, env.payload);
  }
}
