/**
 * The half of DevTools that runs on every clustered node.
 *
 * Exactly one node in a cluster serves the UI; the rest run this, which
 * answers "how is your node doing?" and nothing else.  It holds no
 * connections, keeps no history, and costs one envelope handler plus the
 * sampling every other node already does for its own overview.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cluster } from '../../cluster/Cluster.js';
import { NodeSampler } from '../internal/NodeSampler.js';
import { toActorNode } from '../taps/ActorTreeTap.js';
import {
  DEVTOOLS_AGENT_PATH,
  DEVTOOLS_COLLECTOR_PATH,
  isNodeQuery,
  type NodeReportMessage,
} from './NodeProtocol.js';
import { NodeAddress } from '../../cluster/NodeAddress.js';

export class DevToolsNodeAgent {
  private unregister: (() => void) | null = null;
  private readonly sampler: NodeSampler;

  constructor(
    private readonly system: ActorSystem,
    private readonly cluster: Cluster,
    sampler: NodeSampler,
  ) {
    this.sampler = sampler;
  }

  start(): void {
    if (this.unregister !== null) return;
    this.unregister = this.cluster._registerEnvelopeHandler(
      DEVTOOLS_AGENT_PATH,
      (envelope) => this.onEnvelope(envelope.body),
    );
  }

  stop(): void {
    this.unregister?.();
    this.unregister = null;
  }

  /** This node's own figures, for the serving node's local half. */
  figures(): ReturnType<NodeSampler['figures']> {
    return this.sampler.figures(this.cluster.selfAddress.toString());
  }

  private onEnvelope(body: unknown): void {
    // The body arrives off the network.  Anything that is not a
    // well-formed query is dropped rather than answered: a DevTools
    // agent has no business guessing at malformed input.
    if (!isNodeQuery(body)) return;
    const report: NodeReportMessage = {
      kind: 'devtools-node-report',
      round: body.round,
      figures: this.figures(),
      ...(body.wantActors
        ? {
          actors: this.system._inspectTree()
            .map((cell) => toActorNode(cell, this.cluster.selfAddress.toString())),
        }
        : {}),
    };
    const to = parseAddress(body.from);
    if (to === null) return;
    this.cluster._sendEnvelope(to, {
      t: 'envelope',
      to: DEVTOOLS_COLLECTOR_PATH,
      from: DEVTOOLS_AGENT_PATH,
      body: report,
    });
  }
}

/**
 * `systemName@host:port` back into an address.
 *
 * Hand-parsed rather than trusted: the string came off the wire, and a
 * reply sent to a mangled address is a reply sent somewhere.
 */
function parseAddress(text: string): NodeAddress | null {
  const at = text.indexOf('@');
  const colon = text.lastIndexOf(':');
  if (at <= 0 || colon <= at + 1) return null;
  const port = Number(text.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return new NodeAddress(text.slice(0, at), text.slice(at + 1, colon), port);
}
