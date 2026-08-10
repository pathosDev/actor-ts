// Stable-observation cluster bootstrap (#148) — the phase that decides which
// node, if any, may form a cluster from nothing.  See `StableObservation` for
// the failure modes it closes and why the election alone would not.
export { StableObservation, StableObservationError } from './StableObservation.js';
export type { JoinTargets } from './StableObservation.js';
export {
  StableObservationOptions,
  StableObservationOptionsBuilder,
  StableObservationOptionsValidator,
  readStableObservationOptionsFromConfig,
  isWildcardHost,
  DEFAULT_STABLE_MARGIN_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_REQUIRED_CONTACT_POINTS,
  DEFAULT_SELF_ELECTION_GRACE_MS,
} from './StableObservationOptions.js';
export type {
  StableObservationOptionsType,
  StableObservationTuning,
  StableObservationConfigDefaults,
} from './StableObservationOptions.js';
