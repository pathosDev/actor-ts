/**
 * Who a peer may address **by name** over the cluster wire (#877, #964).
 *
 * Two entry points resolve a path a remote party chose — `Cluster.dispatchEnvelope`
 * for a cluster member's `envelope` frame, and `ClusterClientReceptionist` for an
 * outside `ClusterClient`'s `cluster-client-envelope` — and both hand the string
 * to `ActorSystem._resolvePath`, which walks from the **root** cell.  That walk
 * has no guardian scope of its own, so `/system/…` resolved exactly like
 * `/user/…` and every framework actor was addressable by anyone who completed a
 * `hello`.  This module is the scope those two sites did not have.
 *
 * **What is not here, deliberately.**  There is nothing to do about "system
 * *messages*": `SystemCommand` is an in-process type with no wire
 * representation, `WireMessage` has seven kinds and none of them is one, and
 * `PoisonPill` / `Kill` are matched by singleton identity, which a JSON-decoded
 * body can never satisfy.  The reachable surface is the *path*, and that is
 * what this gates.
 */

import type { ActorSystem } from '../ActorSystem.js';
import type { Logger } from '../Logger.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import { ENVELOPE_REFUSAL_REPORT_INTERVAL_MS } from './Constants.js';
import type { NodeAddress } from './NodeAddress.js';

/**
 * The guardian a peer may never reach through generic path resolution.
 *
 * Framework actors live under it, and every one of them that is legitimately
 * addressable from another node already registers a handler with
 * `Cluster._registerEnvelopeHandler` — which `dispatchEnvelope` consults
 * *before* it touches the actor tree.  That registry is the sanctioned door,
 * and it exists precisely because generic resolution delivers `ref.tell(body)`
 * with no sender attached: #584 and #712 moved sharding through it for exactly
 * that reason, and `internal/SystemPaths.ts` names this fallback as the hazard
 * a mismatched well-known path falls into.
 */
const SYSTEM_GUARDIAN_SEGMENT = 'system';

/** The suffix that turns an allow-list entry into a whole subtree. */
const SUBTREE_SUFFIX = '/*';

/** Why an inbound envelope's target path was refused. */
export type EnvelopeRefusalReason = 'system-path' | 'not-allow-listed';

/**
 * Which wire seam refused it.  Drawn from code and never from a payload, the
 * same rule `cluster_envelope_from_mismatch_total{frame}` already follows, so
 * the series count is bounded by how many seams ask rather than by what anyone
 * sends.
 */
export type RefusedFrameKind = 'envelope' | 'cluster-client-envelope';

/**
 * Render `['user', 'orders', '7']` as the `/user/orders/7` an operator writes.
 *
 * Guardian-rooted rather than a full `actor-ts://<system>/…` URI: the system
 * name is this node's own, so repeating it in every allow-list entry would add
 * a value that is either constant or wrong.  It is also the form both call
 * sites can produce — `Cluster` starts from a URI, the receptionist from a
 * string that may be bare — so one spelling covers both.
 */
export function guardianRootedPath(segments: readonly string[]): string {
  return `/${segments.join('/')}`;
}

/**
 * Normalise one allow-list entry: a leading `/` is optional, a trailing one is
 * dropped, and `*` is only ever recognised as a whole trailing segment.
 *
 * Done once, when the policy is built, rather than per envelope — the list is
 * fixed at `Cluster.join` and an inbound frame should not pay for parsing it.
 */
function normalizeEntry(entry: string): string {
  const trimmed = entry.trim();
  const rooted = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return rooted.length > 1 && rooted.endsWith('/') ? rooted.slice(0, -1) : rooted;
}

/**
 * Whether `path` — guardian-rooted, as {@link guardianRootedPath} renders it —
 * is admitted by one already-normalised allow-list entry.
 *
 * **The matching semantics, decided here for the whole project (#877), and
 * inherited by `remote.large-message-destinations` (#846).**  An entry is an
 * *exact* path unless it ends in `/*`, in which case it is that path and
 * everything below it.  Three alternatives were on the table and each loses
 * something this one keeps:
 *
 * - *Exact only* is unusable against the paths that actually need listing:
 *   a sharded entity lives at `/user/<region>/<shard>/<entity>` and is minted
 *   at run time, so no operator can enumerate them.
 * - *Implicit prefix* — every entry matching anything beneath it — makes the
 *   safe case impossible to write.  An operator naming one actor would silently
 *   admit its whole subtree, and there would be no spelling that does not.
 * - *A general glob* is a matching language, with its own escaping, its own
 *   precedence and its own bugs, compiled per entry out of operator input.  It
 *   buys `/user/*_/inbox`, which nothing has asked for.
 *
 * The suffix is **segment-anchored**, which is the half that carries the
 * security: `/user/admin/*` admits `/user/admin` and `/user/admin/tokens`, and
 * refuses `/user/administrator` — the string-prefix trap that makes a naive
 * `startsWith` allow-list worse than none.
 */
function admits(entry: string, path: string): boolean {
  if (!entry.endsWith(SUBTREE_SUFFIX)) return entry === path;
  const root = entry.slice(0, -SUBTREE_SUFFIX.length);
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The inbound-path trust policy a node was started with, plus the audit signal
 * for what it turns away.
 *
 * One instance per node, shared by both wire seams rather than one each.  That
 * is not only tidiness: the folded WARN below is a budget, and two instances
 * would hand a party that can reach both entry points twice the log volume for
 * the same probing.
 */
export class EnvelopeTrust {
  private readonly trustedSelectionPaths: readonly string[];
  /** Refusals counted since each reason last reached the log. */
  private readonly suppressed: Record<EnvelopeRefusalReason, number> =
    { 'system-path': 0, 'not-allow-listed': 0 };
  /** When each reason last reached the log — `0` so the first one always does. */
  private readonly lastReportedAt: Record<EnvelopeRefusalReason, number> =
    { 'system-path': 0, 'not-allow-listed': 0 };

  constructor(
    private readonly system: ActorSystem,
    private readonly log: Logger,
    private readonly untrustedMode: boolean,
    trustedSelectionPaths: readonly string[],
  ) {
    this.trustedSelectionPaths = trustedSelectionPaths.map(normalizeEntry);
  }

  /**
   * Whether the generic path-resolution fallback may deliver to `segments` —
   * `null` when it may, the reason when it may not.
   *
   * Asked **before** the tree walk, not after: a path this node will not
   * deliver to is also a path it has no reason to look up, and answering from
   * the policy alone keeps the refusal from depending on whether the actor
   * happens to exist.  That is what stops the refusal doubling as an
   * existence oracle for an outside prober.
   *
   * `/system` is refused whether or not {@link untrustedMode} is on, and that
   * is the one place this deliberately does more than #877 asked for — see the
   * module header and the commit that introduced it.  A switch defaulted off
   * would have left #964's high-severity reachability open on every deployment
   * that did not opt in, and there is no configuration in which reaching a
   * framework actor *past* its registered handler is the intended behaviour.
   */
  refusalFor(segments: readonly string[]): EnvelopeRefusalReason | null {
    if (segments[0] === SYSTEM_GUARDIAN_SEGMENT) return 'system-path';
    if (!this.untrustedMode) return null;
    const path = guardianRootedPath(segments);
    return this.trustedSelectionPaths.some((entry) => admits(entry, path))
      ? null
      : 'not-allow-listed';
  }

  /**
   * Count one refusal, and fold it into at most one WARN per reason per
   * {@link ENVELOPE_REFUSAL_REPORT_INTERVAL_MS}.
   *
   * **A counter carries the signal; the log is rate-limited.**  Every envelope
   * is its own frame, so unlike gossip there is no frame's worth of refusals to
   * fold — a WARN per refusal would let a peer write this node's log at line
   * rate, which is the amplification `ClusterClientReceptionist.countSenderMismatch`
   * and `Cluster.reportRefusals` both already refuse to hand out (#131).  It is
   * still a WARN and not a debug line, because the first refusal after turning
   * `untrusted-mode` on is usually an allow-list that is missing an entry, and
   * an operator who cannot see that has a silent black hole instead.
   *
   * **The throttle is keyed on the reason and nothing else.**  Keying it on the
   * peer would be more informative and is exactly the map an attacker grows:
   * a `ClusterClient`'s address is self-asserted in its `hello`, so one party
   * can present as thousands.  The reason is a closed union of two values, so
   * the state here is two counters, permanently.
   *
   * Neither the counter nor the line carries the requested path.  As a label it
   * is unbounded cardinality (#131); as log text it is an unvalidated payload
   * string, which is the shape that forged whole log lines in #573.  The
   * connection's peer is both trustworthy and the more useful of the two — it
   * names the party an operator would firewall.
   */
  report(from: NodeAddress, frame: RefusedFrameKind, reason: EnvelopeRefusalReason): void {
    metricsOf(this.system).counter(
      'cluster_envelope_refusals_total', { reason, frame },
      {
        help: 'Cumulative count of inbound envelopes refused because their target path '
          + 'was outside what this node accepts by name.',
      },
    ).inc();
    this.suppressed[reason] += 1;
    const now = Date.now();
    if (now - this.lastReportedAt[reason] < ENVELOPE_REFUSAL_REPORT_INTERVAL_MS) return;
    this.lastReportedAt[reason] = now;
    const count = this.suppressed[reason];
    this.suppressed[reason] = 0;
    this.log.warn(
      `refused ${count} inbound ${frame} frame(s) — ${this.refusalDetail(reason)}; `
      + `most recently from ${from}`,
    );
  }

  /** The operator-facing half of one {@link EnvelopeRefusalReason}. */
  private refusalDetail(reason: EnvelopeRefusalReason): string {
    // Inline arms on purpose: this computes a string rather than dispatching an
    // incoming message, which is the exemption the delegation rule carves out —
    // and it is the same shape as `Cluster.refusalDetail` one seam over.
    return reason === 'system-path'
      ? 'the target path is under /system, which is reachable only through the '
        + 'handler its owner registered, never by name'
      : `untrusted-mode is on and the target path is not in trusted-selection-paths `
        + `(${this.trustedSelectionPaths.length} entr`
        + `${this.trustedSelectionPaths.length === 1 ? 'y' : 'ies'})`;
  }
}
