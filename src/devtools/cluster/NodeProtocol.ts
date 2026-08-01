/**
 * What DevTools nodes say to each other.
 *
 * A separate vocabulary from the browser protocol: this one crosses the
 * cluster transport between peers of the same version, so it carries no
 * compatibility promise and needs no version negotiation.  The browser
 * protocol is the contract; this is plumbing behind it.
 *
 * Addressed by a fixed envelope path rather than by actor path, the way
 * the singleton manager is.  A path a peer can compute without resolving
 * anything is one less thing to get wrong while a node is joining.
 */
import type { ActorNode, NodeFigures } from '../protocol/index.js';

/** Envelope path every DevTools-enabled node answers on. */
export const DEVTOOLS_AGENT_PATH = '/devtools/node-agent';
/** Envelope path the serving node collects replies on. */
export const DEVTOOLS_COLLECTOR_PATH = '/devtools/collector';

/** The serving node asking a peer how it is doing. */
export type NodeQueryMessage = {
  readonly kind: 'devtools-node-query';
  /** Where to answer — the asker's cluster address. */
  readonly from: string;
  /** Echoed back, so a late reply to a previous round is recognisable. */
  readonly round: number;
  /** Whether the actor tree is wanted; it is far larger than the figures. */
  readonly wantActors: boolean;
};

/** A peer's answer. */
export type NodeReportMessage = {
  readonly kind: 'devtools-node-report';
  readonly round: number;
  readonly figures: NodeFigures;
  /** Present only when the round asked for it. */
  readonly actors?: ReadonlyArray<ActorNode>;
};

/** Anything a DevTools node may send another. */
export type NodeMessage = NodeQueryMessage | NodeReportMessage;

/** @internal Narrow an untrusted envelope body to a query. */
export function isNodeQuery(body: unknown): body is NodeQueryMessage {
  const message = body as Partial<NodeQueryMessage> | null;
  return message !== null
    && message?.kind === 'devtools-node-query'
    && typeof message.from === 'string'
    && typeof message.round === 'number';
}

/** @internal Narrow an untrusted envelope body to a report. */
export function isNodeReport(body: unknown): body is NodeReportMessage {
  const message = body as Partial<NodeReportMessage> | null;
  return message !== null
    && message?.kind === 'devtools-node-report'
    && typeof message.round === 'number'
    && typeof message.figures === 'object'
    && message.figures !== null;
}
