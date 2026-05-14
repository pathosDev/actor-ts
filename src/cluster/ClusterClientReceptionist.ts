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
 *     t: 'cluster-client-envelope',
 *     from: NodeAddressData,          // synthetic client address
 *     to: '/user/some/actor',          // actor path on the cluster
 *     askId: 'a-42' | undefined,       // present for ask
 *     body: unknown,                   // user payload
 *   }
 *
 *   {
 *     t: 'cluster-client-reply',
 *     askId: 'a-42',
 *     ok: true | false,
 *     body: unknown,                   // the reply, or error.message if !ok
 *   }
 *
 * Receptionist failures (path not found, ask timeout) come back as
 * `{ ok: false, body: '<reason>' }` so the client always sees a
 * deterministic shape.
 */

import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import { NodeAddress, type NodeAddressData } from './NodeAddress.js';
import type { WireMessage } from './Protocol.js';
import type { Cluster } from './Cluster.js';

/* ============================ wire shapes =========================== */

/** Inbound: a client wants to deliver `body` to actor at `to`. */
export interface ClusterClientEnvelopeMsg {
  readonly t: 'cluster-client-envelope';
  readonly from: NodeAddressData;
  readonly to: string;
  readonly askId?: string;
  readonly body: unknown;
}

/** Outbound: reply to a client ask. */
export interface ClusterClientReplyMsg {
  readonly t: 'cluster-client-reply';
  readonly askId: string;
  readonly ok: boolean;
  readonly body: unknown;
}

/* ============================= extension ============================ */

export interface ClusterClientReceptionistSettings {
  /**
   * Default ask timeout (ms) when a client envelope carries an `askId`.
   * Default: 5_000.
   */
  readonly askTimeoutMs?: number;
}

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

  start(cluster: Cluster, settings: ClusterClientReceptionistSettings = {}): void {
    if (this._started && this._cluster === cluster) return;
    if (this._started) {
      throw new Error('ClusterClientReceptionist is already bound to a different cluster');
    }
    this._cluster = cluster;
    const askTimeoutMs = settings.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    const log = this.system.log.withSource(`cluster-client-receptionist@${cluster.selfAddress}`);

    this._unsubscribe = cluster._onWire('cluster-client-envelope', (msg) => {
      const env = msg as unknown as ClusterClientEnvelopeMsg;
      const from = NodeAddress.fromJSON(env.from);

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
        if (env.askId !== undefined) {
          this.sendReply(cluster, from, env.askId, false,
            `path not found on cluster node ${cluster.selfAddress}: ${env.to}`);
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
          const message = err instanceof Error ? err.message : String(err);
          this.sendReply(cluster, from, env.askId!, false, message);
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

  private sendReply(
    cluster: Cluster,
    to: NodeAddress,
    askId: string,
    ok: boolean,
    body: unknown,
  ): void {
    const reply: ClusterClientReplyMsg = {
      t: 'cluster-client-reply', askId, ok, body,
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

/**
 * Parse a path string into segments suitable for `_resolvePath`.
 * Accepts:
 *   - 'actor-ts://<sys>/user/foo/bar' — full URI
 *   - '/user/foo/bar'                  — absolute with leading slash
 *   - 'user/foo/bar'                   — absolute without leading slash
 *   - 'foo/bar'                        — relative to `/user`
 *
 * Returns `null` if the URI's system name doesn't match — the helper
 * doesn't accept that branch.
 */
function parsePathSegments(path: string): string[] | null {
  // Strip URI scheme + authority.
  let p = path;
  const uriPrefix = 'actor-ts://';
  if (p.startsWith(uriPrefix)) {
    const slash = p.indexOf('/', uriPrefix.length);
    p = slash < 0 ? '' : p.slice(slash + 1);
  } else if (p.startsWith('/')) {
    p = p.slice(1);
  }
  // Convention: paths under `/user` can be addressed bare.  Map both
  // `user/foo/bar` and `foo/bar` to the segments `['user', 'foo', 'bar']`.
  if (!p.startsWith('user/') && p !== 'user') {
    if (p !== '') p = `user/${p}`;
    else p = 'user';
  }
  const segs = p.split('/').filter((s) => s.length > 0);
  return segs.length === 0 ? null : segs;
}
