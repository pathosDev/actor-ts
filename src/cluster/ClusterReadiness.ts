import { OptionsValidator } from '../util/OptionsValidator.js';
import { selfIsFullMember } from './ClusterHealthChecks.js';
import { readClusterBootstrapDefaultsFromConfig } from './ClusterBootstrapOptions.js';
import type { Cluster } from './Cluster.js';
import type { Member } from './Member.js';
import type { NodeAddress } from './NodeAddress.js';
import type { MemberStatus } from './Protocol.js';

/**
 * Built-in default for {@link ClusterReadinessOptions.minimumMembers} — one
 * `up` member, i.e. "this node is a full member and nothing more".  It keeps
 * the single-node development flow ready the moment it self-elects; a
 * deployment states its real replica expectation via
 * `actor-ts.cluster.bootstrap.minimum-members` or per call.
 */
export const DEFAULT_MINIMUM_MEMBERS = 1;

/**
 * Per-call options for {@link Cluster.awaitReady} / {@link Cluster.isReady}.
 *
 * Deliberately a plain type with a validator and **no builder**: this is a
 * call-site parameter bag (like `subscribe`'s `{ replayMode }`), not a
 * component's configuration — nothing constructs one once and layers HOCON
 * over the instance, so the three-export options pattern would be ceremony.
 */
export type ClusterReadinessOptions = {
  /**
   * Fewest `up` members — self included — before the cluster counts as
   * ready.  Falls back to `actor-ts.cluster.bootstrap.minimum-members`, then
   * to {@link DEFAULT_MINIMUM_MEMBERS}.  Size it to the deployment's replica
   * count for the same reason as the observation's
   * `required-contact-points`: under the default, a node that self-elected
   * into a cluster of one is already "ready", which is right for single-node
   * development and wrong for a three-replica service.
   */
  readonly minimumMembers?: number;
  /**
   * Deadline in milliseconds, strictly positive.  Unset waits indefinitely,
   * like `ActorSystem.whenTerminated()` — this layer deliberately has no
   * built-in deadline, because the one budget that would make a good default
   * (the stable-observation election grace of a node waiting on the winner)
   * is unknowable here, and a flat number silently under-covers it (#1086).
   * Pair it with a timeout wherever the cluster may legitimately never form;
   * a node that has left or been removed never becomes ready.  On expiry the
   * promise rejects with {@link ClusterReadyTimeoutError}; a one-shot probe
   * is {@link Cluster.isReady}.
   */
  readonly timeoutMs?: number;
};

export class ClusterReadinessOptionsValidator extends OptionsValidator<ClusterReadinessOptions> {
  constructor() {
    super('ClusterReadinessOptions');
  }

  protected rules(): void {
    this.positiveInt('minimumMembers');
    this.positiveNumber('timeoutMs');
  }
}

/**
 * The deadline of {@link Cluster.awaitReady} fired before the cluster was
 * ready.  A distinct type for the same reason `StableObservationError` is
 * one: the caller's sane responses — fail the process, retry, keep running
 * degraded — differ from a programming error's, and both arrive through the
 * same `await`.  The fields carry the state an operator asks about first.
 */
export class ClusterReadyTimeoutError extends Error {
  constructor(
    message: string,
    /** Self's status in its own view when the deadline fired; `undefined` = no record yet. */
    readonly selfStatus: MemberStatus | undefined,
    /** How many members were `up`, self included. */
    readonly upMemberCount: number,
    /** The bar that was not met. */
    readonly minimumMembers: number,
    /** The deadline that fired, in milliseconds. */
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'ClusterReadyTimeoutError';
  }
}

/**
 * The readiness predicate, pure: self is a full member — via
 * {@link selfIsFullMember}, so `up` only; `weakly-up` deliberately does not
 * count, matching the `/ready` endpoint's `cluster-membership` check — AND
 * at least `minimumMembers` members are `up`.
 *
 * Deliberately **not** the readiness aggregate of `healthChecksOf(system)`:
 * app-registered checks routinely pass only after initialisation that runs
 * *after* bootstrap, so waiting on the aggregate could deadlock the very
 * call that is supposed to come first.  `/ready` stays the external view;
 * this is the in-process one.
 */
export function clusterIsReady(
  members: ReadonlyArray<Member>,
  self: NodeAddress,
  minimumMembers: number,
): boolean {
  if (!selfIsFullMember(members, self)) return false;
  let upCount = 0;
  for (const member of members) {
    if (member.status === 'up') upCount++;
  }
  return upCount >= minimumMembers;
}

/**
 * Engine behind {@link Cluster.isReady} — validates, resolves
 * `minimumMembers` (explicit > HOCON > built-in), probes once.
 * `timeoutMs` is ignored here; a probe has no deadline.
 */
export function isClusterReadyNow(cluster: Cluster, options?: ClusterReadinessOptions): boolean {
  new ClusterReadinessOptionsValidator().validate(options ?? {});
  return clusterIsReady(
    cluster.getMembers(),
    cluster.selfAddress,
    resolveMinimumMembers(cluster, options),
  );
}

/**
 * Engine behind {@link Cluster.awaitReady}.  Public so callers wiring
 * `Cluster.join` by hand get the same wait `bootstrapCluster` uses.
 *
 * Invalid options throw synchronously ({@link OptionsError}); only the
 * operational outcome travels through the promise.  The listener ignores the
 * event's identity and re-evaluates the predicate against the live
 * accessors — `subscribe` replays synchronously through the same
 * `statusEventsOf` as live emission, which is what makes this race-free
 * without a poll loop.
 */
export function awaitClusterReady(
  cluster: Cluster,
  options?: ClusterReadinessOptions,
): Promise<void> {
  new ClusterReadinessOptionsValidator().validate(options ?? {});
  const minimumMembers = resolveMinimumMembers(cluster, options);
  const timeoutMs = options?.timeoutMs;
  const ready = (): boolean =>
    clusterIsReady(cluster.getMembers(), cluster.selfAddress, minimumMembers);
  if (ready()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let done = false;
    // `unsubscribe` is assigned AFTER cluster.subscribe() returns, but the
    // subscribe callback may fire synchronously during replay.  Hold it in a
    // mutable slot so the callback can read it without a TDZ error and clear
    // it safely once.
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (err?: ClusterReadyTimeoutError): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (err) reject(err); else resolve();
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        const selfStatus = cluster.selfMember()?.status;
        const upMemberCount = cluster.upMembers().length;
        settle(new ClusterReadyTimeoutError(
          `cluster readiness: this node is ${selfStatus === undefined ? 'not a member yet' : `'${selfStatus}'`} `
          + `with ${upMemberCount} of ${minimumMembers} required up member(s) after ${timeoutMs} ms — `
          + `check that the seeds are reachable and, behind stable observation, that the budget `
          + `covers the self-election grace.`,
          selfStatus,
          upMemberCount,
          minimumMembers,
          timeoutMs,
        ));
      }, timeoutMs);
      // A pending readiness wait must not hold the process open on its own.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
    }
    unsubscribe = cluster.subscribe(() => {
      if (ready()) settle();
    });
    // If replay already satisfied the predicate synchronously, settle() ran
    // with `unsubscribe === null` — clean up the listener now.
    if (done && unsubscribe) { (unsubscribe as () => void)(); unsubscribe = null; }
  });
}

/** Explicit > `actor-ts.cluster.bootstrap.minimum-members` > built-in default. */
function resolveMinimumMembers(cluster: Cluster, options?: ClusterReadinessOptions): number {
  if (options?.minimumMembers !== undefined) return options.minimumMembers;
  const fromConfig = readClusterBootstrapDefaultsFromConfig(cluster.system.config).minimumMembers;
  return fromConfig ?? DEFAULT_MINIMUM_MEMBERS;
}
