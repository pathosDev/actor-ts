/**
 * Historical location of the `Success` / `Failure` marker classes used
 * by `pipeTo`.  They have since been unified with the richer `Try<T>`
 * implementation in `src/util/Try.ts` — this module just re-exports so
 * legacy import paths (`import { Success, Failure } from '…/pattern'`)
 * keep working.
 *
 * `Failure` from `Try<T>` still has `.cause` as a back-compat getter,
 * so existing pipeTo consumers that wrote `msg.cause.message` don't
 * need to change.
 */
export { Success, Failure } from '../util/Try.js';
