/**
 * What a `smallest-mailbox` cluster router and a routee node say to each
 * other.
 *
 * A private vocabulary between peers of the same version, like the DevTools
 * node protocol: it never leaves the cluster transport, so it carries no
 * compatibility promise and needs no negotiation.
 *
 * Addressed by a **fixed envelope path** rather than by actor path, the way
 * the singleton manager and the DevTools node agent are.  That is the whole
 * reason this lane exists at all: routees are ordinary user actors owned by
 * the application, and the framework cannot make them answer a question they
 * have no case for in their `onReceive`.  A framework responder sitting on a
 * path of its own answers instead, and the routee never learns it was asked.
 */

/** Envelope path every node hosting a routee answers depth queries on. */
export const MAILBOX_DEPTH_AGENT_PATH = '/cluster/mailbox-depth-agent';

/** A router asking one node how deep the routee's mailbox is. */
export type MailboxDepthQueryMessage = {
  readonly kind: 'mailbox-depth-query';
  /**
   * Full actor path of the asking router, on the asking node — where the
   * report is delivered.
   *
   * The *node* to answer is deliberately not in here: the agent replies to
   * the address the transport authenticated the envelope from, so a peer
   * cannot point a reply at a third node.  `replyTo` can therefore only ever
   * address an actor on the asker's own node.
   */
  readonly replyTo: string;
  /** The routee path whose depth is wanted, e.g. `/user/worker`. */
  readonly routeePath: string;
};

/** One node's answer: how many user messages are queued at the routee. */
export type MailboxDepthReportMessage = {
  readonly kind: 'mailbox-depth-report';
  /** The answering node, as `system@host:port`. */
  readonly node: string;
  /** Echoed back, so a router only caches depths for the path it asked about. */
  readonly routeePath: string;
  /** Queued user messages at the routee when the query was served. */
  readonly depth: number;
};

/** Anything the mailbox-depth lane puts on the wire. */
export type MailboxDepthMessage = MailboxDepthQueryMessage | MailboxDepthReportMessage;

/** @internal Narrow an untrusted envelope body to a query. */
export function isMailboxDepthQuery(body: unknown): body is MailboxDepthQueryMessage {
  const message = body as Partial<MailboxDepthQueryMessage> | null;
  return message !== null
    && message?.kind === 'mailbox-depth-query'
    && typeof message.replyTo === 'string'
    && typeof message.routeePath === 'string';
}

/**
 * @internal Narrow an untrusted envelope body to a report.
 *
 * Runs against every message a `smallest-mailbox` router receives, because a
 * report arrives through the router's own mailbox rather than through a
 * handler of its own — the same shape `RouterActor` uses for the `Terminated`
 * the system delivers.  A user message would have to carry this exact `kind`
 * *and* all three fields at the right types to be mistaken for one.
 */
export function isMailboxDepthReport(body: unknown): body is MailboxDepthReportMessage {
  const message = body as Partial<MailboxDepthReportMessage> | null;
  return message !== null
    && message?.kind === 'mailbox-depth-report'
    && typeof message.node === 'string'
    && typeof message.routeePath === 'string'
    && typeof message.depth === 'number';
}

/**
 * Materialise the full wire-path of a routee on a given node.
 *
 * `routeePath` is given in the user-friendly relative form (`'/user/worker'`),
 * while everything that resolves a path — the cluster's envelope dispatcher,
 * `ActorSystem._resolvePath` via `parsePathSegments` — wants the full
 * `actor-ts://system/...` shape.  It lives here rather than in either caller
 * because the router builds a routee's path and the agent resolves it, and the
 * two disagreeing would mean the depth of some *other* actor (or none) being
 * reported for the routee.  One function, so they cannot drift.
 *
 * Built per node because the system name belongs to the target — in practice
 * every member of a cluster shares one, but assuming so is free to avoid.
 */
export function routeeFullPath(systemName: string, routeePath: string): string {
  const trimmed = routeePath.replace(/^\/+/, '');
  return `actor-ts://${systemName}/${trimmed}`;
}
