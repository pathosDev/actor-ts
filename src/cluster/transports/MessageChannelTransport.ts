import { NodeAddress } from '../NodeAddress.js';
import type { WireMessage } from '../Protocol.js';
import type { Transport, WireHandler } from '../Transport.js';

/**
 * Message shape carried over the underlying MessageChannel.  The broker
 * pattern means every outbound frame from a worker includes the sender
 * address (so the receiver can put it in `WireHandler`) and the intended
 * recipient (so the broker can route it).
 */
export interface BrokeredMessage {
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly to: ReturnType<NodeAddress['toJSON']>;
  readonly payload: WireMessage;
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

  send(to: NodeAddress, msg: WireMessage): void {
    if (!this.running) return;
    const envelope: BrokeredMessage = {
      from: this.self.toJSON(),
      to: to.toJSON(),
      payload: msg,
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
