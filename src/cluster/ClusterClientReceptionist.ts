/**
 * Cluster-side endpoint for {@link ClusterClient} (#86).
 *
 * The receptionist is a thin wire-handler bridge: a `cluster-client-
 * envelope` frame coming over a cluster transport gets unpacked, the
 * target actor is resolved through the local `ActorSystem`, and the
 * message is delivered.  When the envelope carries an `askId`, the
 * receptionist forwards as an ask + sends the reply back as a
 * `cluster-client-reply` over the same transport.
 *
 * What this is NOT:
 *   - It is NOT a gateway for *cross-cluster* communication.  A
 *     ClusterClient connects to one cluster — the receptionist on that
 *     cluster forwards locally to that node's user actor tree.
 *   - It does NOT route to other cluster nodes.  If you want sharded
 *     routing, the local actor on the receiving node has to do that
 *     (e.g. via `ClusterSharding`).  Receptionist's job is just the
 *     in-tree lookup.
 *
 * Wire format — symmetric on both directions:
 *
 *   {
 *     kind: 'cluster-client-envelope',
 *     from: NodeAddressData,          // synthetic client address
 *     to: '/user/some/actor',          // actor path on the cluster
 *     askId: 'a-42' | undefined,       // present for ask
 *     body: unknown,                   // user payload
 *   }
 *
 *   {
 *     kind: 'cluster-client-reply',
 *     askId: 'a-42',
 *     ok: true | false,
 *     body: unknown,                   // the reply, or a redacted reason if !ok
 *   }
 *
 * Receptionist failures (path not found, ask timeout) come back as
 * `{ ok: false, body: '<reason>' }` so the client always sees a
 * deterministic shape.  That reason is written here and never quotes the
 * failure the cluster actually suffered — see `onAskFailure` below for why
 * a client is not a peer.
 */

import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { Logger } from '../Logger.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import { randomUuid } from '../util/RandomString.js';
import { NodeAddress, type NodeAddressData } from './NodeAddress.js';
import type { WireMessage } from './Protocol.js';
import type { Cluster } from './Cluster.js';
import { ClusterClientReceptionistOptionsValidator } from './ClusterClientReceptionistOptions.js';
import type { ClusterClientReceptionistOptions, ClusterClientReceptionistOptionsType } from './ClusterClientReceptionistOptions.js';

/* ============================ wire shapes =========================== */

/** Inbound: a client wants to deliver `body` to actor at `to`. */
export type ClusterClientEnvelopeMessage = {
  readonly kind: 'cluster-client-envelope';
  readonly from: NodeAddressData;
  readonly to: string;
  readonly askId?: string;
  readonly body: unknown;
};

/** Outbound: reply to a client ask. */
export type ClusterClientReplyMessage = {
  readonly kind: 'cluster-client-reply';
  readonly askId: string;
  readonly ok: boolean;
  readonly body: unknown;
};

/* ============================= extension ============================ */

/**
 * Per-system extension that runs once `start(cluster)` is called.
 * Registers a wire handler on the cluster transport; calling `stop()`
 * unregisters it.  Re-callable: a second `start(cluster)` on the same
 * cluster returns the same handle.
 */
export class ClusterClientReceptionist implements Extension {
  private _started = false;
  private _unsubscribe: (() => void) | null = null;
  private _cluster: Cluster | null = null;

  constructor(private readonly system: ActorSystem) {}

  start(
    cluster: Cluster,
    options: ClusterClientReceptionistOptions = {},
  ): void {
    if (this._started && this._cluster === cluster) return;
    if (this._started) {
      throw new Error('ClusterClientReceptionist is already bound to a different cluster');
    }
    this._cluster = cluster;
    const resolvedOptions = (options as ClusterClientReceptionistOptionsType);
    new ClusterClientReceptionistOptionsValidator().validate(resolvedOptions);
    const askTimeoutMs = resolvedOptions.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    const log = this.system.log.withSource(`cluster-client-receptionist@${cluster.selfAddress}`);

    this._unsubscribe = cluster._onWire('cluster-client-envelope', (message, peer) => {
      const env = message as unknown as ClusterClientEnvelopeMessage;
      // The reply goes back down the connection the request arrived on, not to
      // the address the payload names.  `NodeAddress.fromJSON(env.from)` threw
      // outright when `from` was absent — a TypeError from inside the
      // frame-dispatch loop (#711) — and when present but forged it made this
      // node send the reply, and open a connection, to an address of the
      // sender's choosing.
      const from = peer;

      // Resolve the target locally.  We use the synchronous `_resolvePath`
      // rather than `actorSelection().resolveOne()` because the client
      // expects a deterministic immediate reply if the path is unknown —
      // there's no point waiting for it to maybe spawn.
      const segments = parsePathSegments(env.to);
      const refOpt = segments
        ? this.system._resolvePath(segments)
        : { isSome: () => false } as { isSome: () => false };

      if (!refOpt.isSome()) {
        // Unknown path — for asks, return an error reply; for tells, drop.
        // The reply names the path the client itself asked for and nothing
        // else: the node's own `selfAddress` used to ride along, which told
        // an outside caller the address this node binds on — not necessarily
        // the one it dialled, when a load balancer or NAT sits between them.
        if (env.askId !== undefined) {
          this.sendReply(cluster, from, env.askId, false, `path not found: ${env.to}`);
        } else {
          log.debug(`cluster-client tell to unknown path ${env.to} — dropped`);
        }
        return;
      }

      const target = refOpt.value as ActorRef<unknown>;
      if (env.askId === undefined) {
        // Fire-and-forget tell.
        try { target.tell(env.body); } catch (e) {
          log.warn(`cluster-client tell to ${env.to} threw`, e as Error);
        }
        return;
      }

      // Ask-and-reply.
      void target.ask(env.body as never, askTimeoutMs).then(
        (reply) => {
          this.sendReply(cluster, from, env.askId!, true, reply);
        },
        (err: unknown) => {
          this.onAskFailure(cluster, from, env.askId!, err, log);
        },
      );
    });
    this._started = true;
  }

  /** Stop accepting client envelopes.  Idempotent. */
  stop(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._cluster = null;
    this._started = false;
  }

  /* --------------------------- internals ---------------------------- */

  /**
   * Answer a failed ask without quoting the failure.
   *
   * **A ClusterClient is not a peer.**  It speaks the same wire as a cluster
   * member, which is exactly what makes the question worth answering out
   * loud: it never joined the membership ring, carries no gossip or
   * heartbeat duty, and a contact point is by design reachable from outside
   * whatever boundary protects the cluster's own links.  Nothing about
   * having completed a `hello` says the party on the other end is entitled
   * to the cluster's internals — and this handler already takes that
   * position elsewhere, replying down the connection the frame arrived on
   * rather than to the `from` the payload claims (#711).
   *
   * The rejection text is authored by arbitrary user actor code, so it is
   * the same class of string as the HTTP default 500's — file paths, SQL
   * fragments, driver internals, sometimes a stack (#130).  It goes to this
   * node's log; the client gets a fixed sentence plus a correlation id drawn
   * here, which is the whole point of the exchange: an outside caller can
   * quote the id in a ticket and an operator can `grep` for it, without the
   * wire ever carrying the reason.
   *
   * The id is drawn locally rather than reusing `askId`, which the *client*
   * chose: an id the node did not author is neither unique across clients
   * nor safe to concatenate into a log line unchecked.
   */
  private onAskFailure(
    cluster: Cluster,
    from: NodeAddress,
    askId: string,
    err: unknown,
    log: Logger,
  ): void {
    const correlationId = randomUuid();
    log.warn(`cluster-client ask failed (correlationId=${correlationId})`, err);
    this.sendReply(
      cluster, from, askId, false,
      `ask failed on the cluster node (correlationId=${correlationId}) — `
      + "the reason is in that node's log",
    );
  }

  private sendReply(
    cluster: Cluster,
    to: NodeAddress,
    askId: string,
    ok: boolean,
    body: unknown,
  ): void {
    const reply: ClusterClientReplyMessage = {
      kind: 'cluster-client-reply', askId, ok, body,
    };
    cluster.transport.send(to, reply as unknown as WireMessage);
  }
}

export const ClusterClientReceptionistId: ExtensionId<ClusterClientReceptionist> =
  extensionId<ClusterClientReceptionist>(
    'actor-ts/cluster/cluster-client-receptionist',
    (system) => new ClusterClientReceptionist(system),
  );

/* ----------------------- path-segment parser ---------------------- */

/** Guardian names a path may start with; anything else is relative to `/user`. */
const GUARDIAN_SEGMENTS = ['user', 'system'] as const;

/**
 * Parse a path string into segments suitable for `_resolvePath`.
 * Accepts:
 *   - 'actor-ts://<sys>/user/foo/bar' — full URI
 *   - '/user/foo/bar'                  — absolute with leading slash
 *   - 'user/foo/bar'                   — absolute without leading slash
 *   - 'system/cluster/receptionist'    — likewise, for framework actors
 *   - 'foo/bar'                        — relative to `/user`
 *
 * Returns `null` if the URI's system name doesn't match — the helper
 * doesn't accept that branch.
 */
function parsePathSegments(path: string): string[] | null {
  // Strip URI scheme + authority.
  let remaining = path;
  const uriPrefix = 'actor-ts://';
  if (remaining.startsWith(uriPrefix)) {
    const slash = remaining.indexOf('/', uriPrefix.length);
    remaining = slash < 0 ? '' : remaining.slice(slash + 1);
  } else if (remaining.startsWith('/')) {
    remaining = remaining.slice(1);
  }
  // Convention: paths under `/user` can be addressed bare, so `foo/bar` and
  // `user/foo/bar` both mean `['user', 'foo', 'bar']`.  `system` has to be
  // recognised as a guardian too, or a framework actor would be unreachable
  // by name — `'system/cluster/receptionist'` would resolve as a *user* actor
  // literally called `system`.
  const isAbsolute = GUARDIAN_SEGMENTS.some(
    (guardian) => remaining === guardian || remaining.startsWith(`${guardian}/`),
  );
  if (!isAbsolute) {
    remaining = remaining === '' ? 'user' : `user/${remaining}`;
  }
  const segs = remaining.split('/').filter((s) => s.length > 0);
  return segs.length === 0 ? null : segs;
}
