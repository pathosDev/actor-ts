import type { Scheduler } from '../Scheduler.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Default seed, so a spec that asks for faults and names no seed still gets a
 * reproducible run rather than a different network every time.
 *
 * A fixed default is the whole point and not a placeholder: an unreproducible
 * chaos test is a flake generator, and this repository has a flake catalogue it
 * is trying to shrink (#290, #1023).  Vary it deliberately — `withSeed(n)` in a
 * loop — when the question is "does this hold for many networks" rather than
 * "does this hold for the network that broke".
 */
export const DEFAULT_TRANSPORT_FAULT_SEED = 0x5EED_1023;

/** No faults at all: the transport behaves exactly as it did undecorated. */
export const DEFAULT_TRANSPORT_DROP_PROBABILITY = 0;
export const DEFAULT_TRANSPORT_DUPLICATE_PROBABILITY = 0;
export const DEFAULT_TRANSPORT_REORDER_WINDOW = 0;
export const DEFAULT_TRANSPORT_LATENCY_MS = 0;

/**
 * What one link does to the frames crossing it.
 *
 * Every field is a *per-frame* decision except {@link reorderWindow}, which is
 * a depth.  All four are independent: a link can drop, duplicate, delay and
 * reorder at once, which is the combination a real loaded network produces and
 * the one no test in this repository could express before.
 */
export type TransportFaultProfileType = {
  /**
   * Probability in `[0, 1]` that a frame is discarded before it is handed on.
   *
   * A gossip round losing a fifth of its pushes is the ordinary condition on a
   * loaded network; the harness had `0` and `1` and nothing between, so
   * "does the membership view still converge" had never been asked.
   */
  readonly dropProbability?: number;
  /**
   * Probability in `[0, 1]` that a frame is delivered twice.
   *
   * Gossip re-delivers by design, and the idempotence of `mergeMember`, of
   * shard-home updates and of `Terminated` fan-out is claimed everywhere and
   * exercised nowhere.
   */
  readonly duplicateProbability?: number;
  /**
   * How many frames may be held back and released out of order.  `0` keeps
   * strict send order.
   *
   * A bounded window rather than a shuffle, deliberately: it models the real
   * failure — a few frames overtaking each other — and it bounds the delay, so
   * a reordered link cannot leave a test waiting forever for a frame that was
   * permuted to the end.
   */
  readonly reorderWindow?: number;
  /**
   * Delivery delay in milliseconds, measured on the {@link
   * FaultyTransportOptionsType.scheduler}.
   *
   * On a `ManualScheduler` this is virtual time, so a slow-but-alive peer —
   * the case a failure detector exists to tell apart from a dead one — is
   * constructed by advancing a clock rather than by sleeping.  With no
   * scheduler the delay is refused rather than silently taken from the wall
   * clock; see {@link FaultyTransportOptionsValidator}.
   */
  readonly latencyMs?: number;
};

/** Plain options-object shape accepted by a `FaultyTransport`. */
export type FaultyTransportOptionsType = TransportFaultProfileType & {
  /**
   * Seed for every random decision this transport makes.  Default
   * {@link DEFAULT_TRANSPORT_FAULT_SEED}.
   *
   * One generator per transport instance, drawn from in send order — which is
   * deterministic under a shared `ManualScheduler`, and is what makes a failed
   * chaos run reproducible from the number in the log.
   */
  readonly seed?: number;
  /**
   * Where {@link TransportFaultProfileType.latencyMs} is measured.  Required
   * for a non-zero latency and unused without one.
   */
  readonly scheduler?: Scheduler;
  /**
   * Per-peer overrides, keyed by the peer's `NodeAddress.toString()`.  A peer
   * named here uses its profile *instead of* the top-level one, not merged
   * with it.
   *
   * Replacement rather than merge because the asymmetric cases this exists for
   * are stated as whole links — "everything is clean except a→b, which drops a
   * third" — and a merge would make the reader compute each link's real
   * profile from two places.
   */
  readonly perPeer?: Readonly<Record<string, TransportFaultProfileType>>;
};

/** Fluent builder for {@link FaultyTransportOptionsType}. */
export class FaultyTransportOptionsBuilder extends OptionsBuilder<FaultyTransportOptionsType> {
  /** Start a fresh builder.  Equivalent to `new FaultyTransportOptionsBuilder()`. */
  static create(): FaultyTransportOptionsBuilder {
    return new FaultyTransportOptionsBuilder();
  }

  /** Probability in `[0, 1]` that a frame is discarded.  Default 0. */
  withDropProbability(dropProbability: number): this {
    return this.set('dropProbability', dropProbability);
  }

  /** Probability in `[0, 1]` that a frame is delivered twice.  Default 0. */
  withDuplicateProbability(duplicateProbability: number): this {
    return this.set('duplicateProbability', duplicateProbability);
  }

  /** How many frames may be held back and released out of order.  Default 0. */
  withReorderWindow(reorderWindow: number): this {
    return this.set('reorderWindow', reorderWindow);
  }

  /** Delivery delay in ms, measured on {@link withScheduler}.  Default 0. */
  withLatencyMs(latencyMs: number): this {
    return this.set('latencyMs', latencyMs);
  }

  /** Seed for every random decision.  Default {@link DEFAULT_TRANSPORT_FAULT_SEED}. */
  withSeed(seed: number): this {
    return this.set('seed', seed);
  }

  /** Where {@link withLatencyMs} is measured.  Required for a non-zero latency. */
  withScheduler(scheduler: Scheduler): this {
    return this.set('scheduler', scheduler);
  }

  /** Per-peer overrides, keyed by `NodeAddress.toString()`. */
  withPerPeer(perPeer: Readonly<Record<string, TransportFaultProfileType>>): this {
    return this.set('perPeer', perPeer);
  }
}

/**
 * Bounds on the fault settings.
 *
 * The probabilities are checked as fractions rather than percentages because
 * both spellings read plausibly at a call site and only one of them is right:
 * `withDropProbability(20)` meaning "20 %" would otherwise drop every frame
 * and present as a partition, which is the failure this whole decorator exists
 * to distinguish from a loss rate.
 */
export class FaultyTransportOptionsValidator extends OptionsValidator<FaultyTransportOptionsType> {
  constructor() {
    super('FaultyTransportOptions');
  }

  protected rules(settings: Partial<FaultyTransportOptionsType>): void {
    this.numberInRange('dropProbability', 0, 1);
    this.numberInRange('duplicateProbability', 0, 1);
    this.nonNegativeInt('reorderWindow');
    this.nonNegativeNumber('latencyMs');
    // A latency with nowhere to measure it would have to fall back to the wall
    // clock, which is precisely the timing dependence `ManualScheduler` exists
    // to remove — so it is refused at construction instead of quietly taken.
    if ((settings.latencyMs ?? 0) > 0 && settings.scheduler === undefined) {
      this.fail(
        'latencyMs',
        'needs a scheduler to measure it on — pass withScheduler(...), '
        + 'normally the same ManualScheduler the spec advances',
        settings.latencyMs,
      );
    }
    for (const [peer, profile] of Object.entries(settings.perPeer ?? {})) {
      // The same bounds, reported against the peer that carries them: a
      // per-peer profile is where a stray percentage is most likely to be
      // written, and "dropProbability must be within [0, 1]" without the peer
      // name sends the reader through every link in the spec.
      const peerSettings = { ...profile, seed: settings.seed } as Partial<FaultyTransportOptionsType>;
      try {
        new PeerProfileValidator(peer).validate(peerSettings);
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }
}

/** {@link FaultyTransportOptionsValidator}'s per-peer half, named for its link. */
class PeerProfileValidator extends OptionsValidator<FaultyTransportOptionsType> {
  constructor(private readonly peer: string) {
    super(`FaultyTransportOptions.perPeer[${peer}]`);
  }

  protected rules(_settings: Partial<FaultyTransportOptionsType>): void {
    this.numberInRange('dropProbability', 0, 1);
    this.numberInRange('duplicateProbability', 0, 1);
    this.nonNegativeInt('reorderWindow');
    this.nonNegativeNumber('latencyMs');
  }
}

/**
 * Accepted input for a `FaultyTransport`: the fluent
 * {@link FaultyTransportOptionsBuilder} OR a plain
 * {@link FaultyTransportOptionsType}.
 */
export type FaultyTransportOptions = FaultyTransportOptionsBuilder | FaultyTransportOptionsType;
/** Value alias so `FaultyTransportOptions.create()` resolves to the builder. */
export const FaultyTransportOptions = FaultyTransportOptionsBuilder;
