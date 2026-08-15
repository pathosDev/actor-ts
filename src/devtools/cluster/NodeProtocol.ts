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

/**
 * The serving node asking a peer how it is doing.
 *
 * Carries no return address on purpose.  It used to name one, and a peer
 * answered wherever it pointed — so a single forged frame made any
 * DevTools-enabled node dial an attacker-chosen host and hand it the
 * whole actor tree.  The answer now goes back down the connection the
 * query arrived on, which is the only address the receiver has any
 * reason to trust (#595).
 */
export type NodeQueryMessage = {
  readonly kind: 'devtools-node-query';
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
    && typeof message.round === 'number';
}

/** @internal Narrow an untrusted envelope body to a report. */
export function isNodeReport(body: unknown): body is NodeReportMessage {
  const message = body as Partial<NodeReportMessage> | null;
  if (message === null || message?.kind !== 'devtools-node-report') return false;
  if (typeof message.round !== 'number') return false;
  // An absent tree means "this round did not ask"; anything that is not an
  // array is a claim the collector would go on to slice and cache.
  if (message.actors !== undefined && !Array.isArray(message.actors)) return false;
  return isNodeFigures(message.figures);
}

/**
 * Counters the serving node adds up across every peer.
 *
 * Listed one by one rather than trusted as a group, because the sum is
 * what breaks: `StatsTap.totalOf` adds these straight into the
 * cluster-wide figures, so a single missing or non-numeric field turns
 * the overview's actor count into `NaN` — a peer poisoning a whole
 * dashboard without sending anything that looks malformed (#593).  The
 * list *is* the check, so it lives beside it.
 */
const FIGURE_COUNTERS = [
  'uptimeMs',
  'actorCount',
  'actorsStarted',
  'actorsStopped',
  'actorsRestarted',
  'deadLetters',
  'messagesProcessed',
  'mailboxDrops',
  'mailboxBacklog',
  'stashedTotal',
  'suspendedActors',
] as const satisfies ReadonlyArray<keyof NodeFigures>;

/** Percentiles weighted into the cluster-wide latency, same reasoning. */
const LATENCY_FIELDS = ['p50Ms', 'p99Ms', 'count'] as const;

/** Depths sorted and shown per node, same reasoning. */
const MAILBOX_DEPTH_FIELDS = ['size', 'stashSize'] as const;

/** Whether every one of `fields` is present on `record` as a finite number. */
function hasFiniteNumbers(record: Record<string, unknown>, fields: ReadonlyArray<string>): boolean {
  for (const field of fields) {
    const reading = record[field];
    if (typeof reading !== 'number' || !Number.isFinite(reading)) return false;
  }
  return true;
}

/** A plain object, which an array and `null` both are not. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a full set of a node's figures. */
function isNodeFigures(value: unknown): value is NodeFigures {
  if (!isRecord(value)) return false;
  // Shape only, deliberately: the collector replaces the reported address
  // with the one the transport supplied, so its *value* is never trusted.
  if (typeof value.address !== 'string' || typeof value.systemName !== 'string') return false;
  if (!hasFiniteNumbers(value, FIGURE_COUNTERS)) return false;
  const latency = value.handlerLatency;
  if (latency !== undefined && !(isRecord(latency) && hasFiniteNumbers(latency, LATENCY_FIELDS))) {
    return false;
  }
  return Array.isArray(value.topMailboxes) && value.topMailboxes.every(isMailboxDepth);
}

/** Whether `value` is one mailbox-depth reading. */
function isMailboxDepth(value: unknown): boolean {
  return isRecord(value)
    && typeof value.path === 'string'
    && typeof value.suspended === 'boolean'
    && hasFiniteNumbers(value, MAILBOX_DEPTH_FIELDS);
}
