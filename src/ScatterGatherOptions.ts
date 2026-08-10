import { OptionsBuilder } from './util/OptionsBuilder.js';
import { OptionsValidator } from './util/OptionsValidator.js';

/**
 * Plain options-object shape accepted by
 * `Router.scatterGatherFirstCompleted(...)`.
 */
export type ScatterGatherOptionsType = {
  /**
   * How long one scatter may run before it is given up on, in
   * milliseconds.  Default `5_000` — the same default `ActorRef.ask`
   * uses, because that is literally what this becomes: the router turns
   * each routee into an `ask` carrying this timeout, so the deadline is
   * enforced per routee and the whole scatter fails only once the last
   * one has expired.
   *
   * Akka spells this `within`; the name here follows the project's
   * `…Ms` convention for durations and says what it actually is — the
   * timeout handed to `ask`.
   *
   * Sizing it is the whole point of the pattern: a hedged request wants a
   * timeout *shorter* than the caller's own, so a stalled replica costs a
   * fraction of the caller's budget rather than all of it.  Set the
   * caller's `ask` timeout above this one, or the caller gives up before
   * the router can report which routees failed.
   */
  readonly timeoutMs?: number;
};

/**
 * Fluent builder for {@link ScatterGatherOptionsType}:
 *
 *     const hedgeOptions = ScatterGatherOptions.create().withTimeoutMs(250);
 *     system.spawn(Router.scatterGatherFirstCompleted(3, Replica, hedgeOptions), 'replicas');
 */
export class ScatterGatherOptionsBuilder extends OptionsBuilder<ScatterGatherOptionsType> {
  /** Start a fresh builder. */
  static create(): ScatterGatherOptionsBuilder {
    return new ScatterGatherOptionsBuilder();
  }

  /** How long one scatter may run before it is given up on (ms). */
  withTimeoutMs(timeoutMs: number): this {
    return this.set('timeoutMs', timeoutMs);
  }
}

/**
 * Validates resolved {@link ScatterGatherOptionsType} settings.
 *
 * `timeoutMs` is optional — unset means the built-in default — but a
 * *present* value has to be a positive finite number: `0` disables
 * `AskResponseRef`'s timer entirely, which would leave every scatter that
 * loses all its routees pending forever with the caller none the wiser.
 */
export class ScatterGatherOptionsValidator extends OptionsValidator<ScatterGatherOptionsType> {
  constructor() {
    super('ScatterGatherOptions');
  }

  protected rules(_s: Partial<ScatterGatherOptionsType>): void {
    this.positiveNumber('timeoutMs');
  }
}

/**
 * Accepted input for `Router.scatterGatherFirstCompleted(...)`: the fluent
 * {@link ScatterGatherOptionsBuilder} OR a plain
 * {@link ScatterGatherOptionsType} object.
 */
export type ScatterGatherOptions = ScatterGatherOptionsBuilder | ScatterGatherOptionsType;
/** Value alias so `ScatterGatherOptions.create()` resolves to the builder. */
export const ScatterGatherOptions = ScatterGatherOptionsBuilder;
