/**
 * How much of a registry one gossip sender may claim (#1074, #1073).
 *
 * The pub-sub mediator and the receptionist both learn what a peer holds
 * from gossip, and both replace a sender's contribution **wholesale** on
 * every frame — that is how a peer's unsubscribes and deregistrations
 * propagate.  So what one frame admits is exactly what the sender holds
 * afterwards, and a quota per frame is a quota per sender.
 *
 * A per-sender quota rather than one shared total, because a shared total is
 * a budget the first peer to fill it denies to everyone else — including, in
 * the mediator, this node's own `Subscribe`s (#1074).  With a quota, what any
 * one peer can occupy is bounded by its own share, and memory by the quota
 * times the peers that can reach the registry.
 *
 * One instance per frame: construct it before walking the claims, ask
 * {@link take} for each, and read {@link refused} afterwards for the single
 * log line the frame earns.  A claim may weigh more than one — the
 * receptionist charges a service key by the actor paths it names — and one
 * that does not fit is refused whole, while later, lighter claims may still
 * fit.  Lives in `util/` because two top-level subsystems use it.
 */
export class SenderClaimQuota {
  private held = 0;
  private refusedClaims = 0;

  constructor(readonly limit: number) {}

  /** Admit a claim of `weight` units if the sender's share still holds it. */
  take(weight: number = 1): boolean {
    if (this.held + weight > this.limit) {
      this.refusedClaims += 1;
      return false;
    }
    this.held += weight;
    return true;
  }

  /** Units this frame's admitted claims hold — the sender's share afterwards. */
  get claimed(): number {
    return this.held;
  }

  /** Claims refused for want of quota. */
  get refused(): number {
    return this.refusedClaims;
  }
}
