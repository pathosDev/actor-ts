import { isWildcardHost } from '../ClusterOptions.js';
import type { SelfElectionPolicy } from '../ClusterOptions.js';
import type { NodeAddress } from '../NodeAddress.js';
import {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUIRED_CONTACT_POINTS,
  DEFAULT_SELF_ELECTION_GRACE_MS,
  DEFAULT_STABLE_MARGIN_MS,
  StableObservationOptionsValidator,
} from './StableObservationOptions.js';
import type {
  StableObservationOptions,
  StableObservationOptionsType,
} from './StableObservationOptions.js';

/**
 * The observation ran out of budget without the contact-point set ever
 * settling — thrown by {@link StableObservation.resolveJoinTargets}.
 *
 * A distinct type because the caller's only sane responses are to fail the
 * process or to retry the whole bootstrap, and both need to be told apart
 * from a programming error in the same `await`.
 */
export class StableObservationError extends Error {
  constructor(
    message: string,
    /** The last set the provider returned, for the operator to compare against reality. */
    readonly lastObserved: ReadonlyArray<string>,
    /** How many `lookup()` polls were spent. */
    readonly polls: number,
  ) {
    super(message);
    this.name = 'StableObservationError';
  }
}

/**
 * What a settled observation decided — the whole input `Cluster.join` needs.
 *
 * The issue's original sketch also carried a `stable: boolean` for a degraded
 * fallback.  It is absent because there is no degraded mode: an observation
 * that never settles throws (see {@link StableObservation}), so every value of
 * this type describes a stable one and a flag that is always `true` would only
 * invite a caller to branch on it.
 */
export type JoinTargets = {
  /**
   * What to pass as `ClusterOptions.seeds` — every contact point except self.
   *
   * The same list for every node, **including the one that won the
   * election**.  That is what makes the election safe: the elected node dials
   * the others exactly like everyone else, so if a cluster is already running
   * it is promoted into that one instead of starting a rival.
   */
  readonly seeds: ReadonlyArray<NodeAddress>;
  /** Whether this node won the address-ordered election. */
  readonly isInitialSeed: boolean;
  /**
   * What to pass as `ClusterOptions.selfElection` — a millisecond grace for
   * the elected initial seed, `'never'` for everyone else.  Derived here
   * rather than left to the caller because getting the pairing wrong is the
   * one mistake that reintroduces the split brain.
   */
  readonly selfElection: SelfElectionPolicy;
  /**
   * The configured election grace, carried for **every** node: the winner's
   * {@link selfElection} equals it, and the non-winners need it to size
   * their readiness budget — on a genuine cold start their promotion cannot
   * arrive before the winner's grace has elapsed, so a wait shorter than
   * this is one that expires while nothing is wrong (#1086).
   */
  readonly selfElectionGraceMs: number;
  /** The settled set, self included, in election order. */
  readonly contactPoints: ReadonlyArray<NodeAddress>;
  /** How many `lookup()` polls it took to settle. */
  readonly polls: number;
};

/**
 * The settings once the built-in defaults are spread under them: every
 * tunable is present, only `log` stays genuinely optional.  Internal — the
 * public shape keeps the tunables optional so a caller can omit them.
 */
type ResolvedStableObservationSettings =
  Required<Omit<StableObservationOptionsType, 'log'>>
  & Pick<StableObservationOptionsType, 'log'>;

/**
 * Stable-observation bootstrapping (#148) — the step that decides *who* starts
 * a cluster before anybody does.
 *
 * ## What it is for
 *
 * A cold start hands every node the same question ("is there a cluster yet?")
 * at the same moment, and discovery answers it differently on each of them:
 * DNS has not fully propagated, a pod is Ready before its IP is in the
 * headless service, the K8s API returns a partial pod list.  Acting on the
 * first answer gives each node a different world, and each of them forms a
 * cluster out of the subset it can see.  Gossip never bridges the results —
 * they are separate clusters with the same name.
 *
 * The fix is to stop treating the first answer as the answer.  This class
 * polls the provider until the set it returns has been **unchanged for
 * `stableMarginMs`**, then orders that set by address and elects the first
 * entry as the only node permitted to form a cluster from nothing.
 *
 * ## Why the election alone would not be enough
 *
 * Electing the lowest address and having it self-elect immediately — the
 * obvious reading — trades one split brain for another. Addresses are assigned
 * by the platform, so a node started later can perfectly well sort first: a
 * scaled-up pod, or a restarted one with a recycled IP. It would win the
 * election against a cluster that is already running and form a second one
 * beside it.
 *
 * So the election does not decide *whether* to join, only who may give up
 * waiting. Every node — winner included — joins with the full contact-point
 * set as its seeds; the winner additionally gets a
 * {@link ClusterOptionsType.selfElection} deadline, and the losers get
 * `'never'`. If a cluster exists, its leader promotes the winner long before
 * the deadline and nothing is formed. If none exists, the deadline expires
 * exactly once, on exactly one node.
 *
 * That is also why this needs no contact-point probe endpoint of its own:
 * "does a cluster already exist?" is answered by the join path itself, which
 * is authoritative, rather than by a second read-only view that can disagree
 * with it.
 *
 * ## Usage
 *
 *     const observationOptions = StableObservationOptions.create()
 *       .withSeedProvider(seedProvider)
 *       .withSelfAddress(selfAddress)
 *       .withRequiredContactPoints(3);
 *     const observation = new StableObservation(observationOptions);
 *     const targets = await observation.resolveJoinTargets();
 *
 *     const clusterOptions = ClusterOptions.create()
 *       .withHost(selfAddress.host)
 *       .withPort(selfAddress.port)
 *       .withSeeds(targets.seeds.map((address) => address.toString()))
 *       .withSelfElection(targets.selfElection);
 *     const cluster = await Cluster.join(system, clusterOptions);
 *
 * `bootstrapCluster` does all of the above when its `stableObservation`
 * option is set; reach for this class directly only when you drive
 * `Cluster.join` yourself.
 */
export class StableObservation {
  private readonly settings: ResolvedStableObservationSettings;

  constructor(options: StableObservationOptions) {
    const settings = {
      stableMarginMs: DEFAULT_STABLE_MARGIN_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      maxWaitMs: DEFAULT_MAX_WAIT_MS,
      requiredContactPoints: DEFAULT_REQUIRED_CONTACT_POINTS,
      selfElectionGraceMs: DEFAULT_SELF_ELECTION_GRACE_MS,
      ...(options as Partial<StableObservationOptionsType>),
    } as ResolvedStableObservationSettings;
    // Required-ness is not something the validator's helpers express — they
    // are no-ops on `undefined` by contract — so the two fields without a
    // default are guarded here, before the rules see them.
    if (settings.seedProvider === undefined) {
      throw new TypeError('StableObservationOptions: seedProvider is required');
    }
    if (settings.selfAddress === undefined) {
      throw new TypeError('StableObservationOptions: selfAddress is required');
    }
    new StableObservationOptionsValidator().validate(settings);
    this.settings = settings;
  }

  /**
   * Poll until the contact-point set settles, then elect.  Rejects with a
   * {@link StableObservationError} once `maxWaitMs` is spent.
   *
   * Throwing rather than falling back to a direct join is deliberate (the
   * issue's open question 3).  The fallback is friendlier exactly once — the
   * first time somebody's discovery is misconfigured — and after that it is
   * indistinguishable from the failure this class exists to prevent: a node
   * that could not agree with anyone about who is out there, joining anyway.
   * A start that fails loudly is recoverable by a restart or an operator; a
   * second cluster is not.
   */
  async resolveJoinTargets(): Promise<JoinTargets> {
    const { stableMarginMs, pollIntervalMs, maxWaitMs } = this.settings;
    const startedAt = Date.now();
    let lastKey: string | null = null;
    let lastObserved: NodeAddress[] = [];
    let unchangedSince = 0;
    let polls = 0;

    for (;;) {
      polls++;
      const observed = await this.observe();
      if (observed !== null) {
        const key = observed.map((address) => address.toString()).join(',');
        lastObserved = observed;
        if (key !== lastKey) {
          if (lastKey !== null) {
            this.log(`contact points changed to [${key}] — stable margin restarted`);
          }
          lastKey = key;
          unchangedSince = Date.now();
        } else if (Date.now() - unchangedSince >= stableMarginMs) {
          this.log(`contact points stable for ${stableMarginMs} ms: [${key}]`);
          return this.elect(observed, polls);
        }
      }

      if (Date.now() - startedAt >= maxWaitMs) {
        throw new StableObservationError(
          `cluster bootstrap: the contact-point set did not stay unchanged for `
          + `${stableMarginMs} ms within the ${maxWaitMs} ms budget (${polls} polls). `
          + `Last observation: [${lastObserved.map((a) => a.toString()).join(', ') || '<none>'}], `
          + `requiredContactPoints=${this.settings.requiredContactPoints}. `
          + `Check that discovery resolves every node and that this node's advertised `
          + `address (${this.settings.selfAddress.toString()}) is the one peers see.`,
          lastObserved.map((address) => address.toString()),
          polls,
        );
      }
      // Clamped to what is left of the budget, so a poll interval close to
      // `maxWaitMs` cannot overshoot the deadline by a whole interval.
      await sleep(Math.min(pollIntervalMs, maxWaitMs - (Date.now() - startedAt)));
    }
  }

  /* --------------------------- internals -------------------------------- */

  /**
   * One poll: the provider's addresses plus self, de-duplicated and ordered.
   *
   * `null` means *"no observation this round"* — a failed lookup or a set
   * below `requiredContactPoints`. That is not the same as an empty set, and
   * conflating the two is precisely how a DNS blip turns into a self-elected
   * cluster of one; here it neither satisfies nor resets the margin, it simply
   * does not count.
   */
  private async observe(): Promise<NodeAddress[] | null> {
    const { seedProvider, selfAddress, requiredContactPoints } = this.settings;
    let discovered: NodeAddress[];
    try {
      discovered = await seedProvider.lookup();
    } catch (err) {
      this.log(`seed provider lookup failed: ${(err as Error).message ?? String(err)}`);
      return null;
    }

    const byKey = new Map<string, NodeAddress>();
    byKey.set(selfAddress.toString(), selfAddress);
    for (const address of discovered) {
      // A peer advertising a wildcard is not dialable and would corrupt the
      // ordering just as a wildcard self would — it must not be counted
      // towards `requiredContactPoints` either.
      if (isWildcardHost(address.host)) {
        this.log(`ignoring contact point ${address.toString()} — wildcard host is not an address`);
        continue;
      }
      byKey.set(address.toString(), address);
    }

    const contactPoints = [...byKey.values()].sort((a, b) => a.compareTo(b));
    if (contactPoints.length < requiredContactPoints) {
      this.log(
        `only ${contactPoints.length} contact point(s) so far, need `
        + `${requiredContactPoints} — waiting`,
      );
      return null;
    }
    return contactPoints;
  }

  /**
   * Lexicographic on `system@host:port`, matching {@link Cluster.leader} —
   * the issue's open question 2.
   *
   * The tie-breaker it weighed (`joinedAt`) is not available: the whole point
   * of this phase is that nothing has joined yet, so there is no join time to
   * order on, and inventing one from the local clock would order the nodes by
   * their clock skew.  Address order needs no shared state at all, which is
   * what lets every observer reach the same answer independently — and the
   * fragility it is charged with (addresses change across restarts) does not
   * apply, because the decision is made once per start and never persisted.
   */
  private elect(contactPoints: NodeAddress[], polls: number): JoinTargets {
    const { selfAddress, selfElectionGraceMs } = this.settings;
    const isInitialSeed = contactPoints[0]!.equals(selfAddress);
    const seeds = contactPoints.filter((address) => !address.equals(selfAddress));
    this.log(
      isInitialSeed
        ? `elected initial seed (lowest of ${contactPoints.length} contact points); `
        + `will form a new cluster only if no peer promotes this node within `
        + `${selfElectionGraceMs} ms`
        : `not the initial seed — ${contactPoints[0]!.toString()} is; joining through `
        + `${seeds.length} seed(s)`,
    );
    return {
      seeds,
      isInitialSeed,
      selfElection: isInitialSeed ? selfElectionGraceMs : 'never',
      selfElectionGraceMs,
      contactPoints,
      polls,
    };
  }

  private log(message: string): void {
    this.settings.log?.(`cluster bootstrap: ${message}`);
  }
}

/**
 * Portable sleep — `Bun.sleep` does not exist on Node or Deno.
 *
 * Deliberately **not** `unref`'d, unlike most timers in this codebase: the
 * process is awaiting this poll and has nothing else to do yet, so releasing
 * the event loop would let it exit silently in the middle of a bootstrap.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
