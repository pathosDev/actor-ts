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
import type { NodeAddress } from '../../cluster/NodeAddress.js';

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
      (envelope, from) => this.onEnvelope(envelope.body, from),
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

  private onEnvelope(body: unknown, from: NodeAddress): void {
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
    // Answer the connection the query came in on, never an address the
    // body named — the rule the whole cluster was hardened to in #564,
    // and the one this agent was missed by.  A query used to carry its
    // own return address; a forged one made this node open an outbound
    // connection to any host an attacker picked and post it the full
    // actor tree, unprompted and unauthenticated (#595).
    this.cluster._sendEnvelope(from, {
      kind: 'envelope',
      to: DEVTOOLS_COLLECTOR_PATH,
      from: DEVTOOLS_AGENT_PATH,
      body: report,
    });
  }
}
