/**
 * The `actor-ts/util` entry point — every module in this directory.
 *
 * `src/util/` is the one directory under `src/` with **no outward import at
 * all**, which is what makes it the tier every subsystem may depend on
 * without any of them depending on each other (`Constants.ts` documents that
 * property at length).  The same property is why the whole of it can be
 * published as one subpath: nothing here drags a subsystem in behind it.
 *
 * **Relationship to the root barrel.**  `src/index.ts` names a curated subset
 * of these — the ones a consumer meets while using the framework itself
 * (`Option`, `Try`, `Either`, `Lazy`, `RingBuffer`, the two bidirectional
 * maps, `randomString`, `safeStringify`, `lazyImportModule`, the redaction
 * helpers, `OptionsBuilder` / `OptionsValidator`).  Those stay exported from
 * the root: public names stay public, and this barrel adds a second door
 * rather than moving anything through it.  What only this door opens is the
 * rest — `TokenBucket`, the CIDR and address-pin primitives, the HTML
 * escapers, `mergeOptions`, the `strip*` scanners, `wrapError` and the
 * cross-subsystem constants (#1404).
 *
 * Ordered by module, alphabetically, so that "is every file here?" is a
 * question `ls src/util` answers.  One name is deliberately absent:
 * `_resetEntropyPool` from `RandomString.ts`, whose own doc comment says
 * there is no production reason to drop entropy and that it exists for a test
 * substituting `crypto.getRandomValues`.  The underscore is the convention;
 * publishing it would make a test hook part of the API.
 */

export { BidirectionalMap } from './BidirectionalMap.js';
export type { BidirectionalMapJson } from './BidirectionalMap.js';

export { BidirectionalMultiMap } from './BidirectionalMultiMap.js';
export type { BidirectionalMultiMapJson } from './BidirectionalMultiMap.js';

// CIDR matching and the address-pin rules built on it — the primitive behind
// both the HTTP IP allowlist and the cluster seed providers' pin lists.
export {
  parseCidr,
  cidrMatches,
  isCidrEntry,
  parseAddressPin,
  addressMatchesPins,
  addressPinRejection,
} from './CidrMatch.js';
export type { ParsedCidr, AddressPin } from './CidrMatch.js';

// The name of a value's class and nothing from the value itself — the shape a
// diagnostic is allowed to record about an untrusted payload.
export { classNameOf } from './ClassName.js';

// The cross-subsystem constants tier.  Public because they are the defaults a
// consumer reads back rather than restates: `DEFAULT_ASK_TIMEOUT_MS` is the
// value a `ScatterGatherRouter` timeout has to stay below, and
// `PATH_TRAVERSAL_SEGMENTS` is the denylist an application's own validator
// should share rather than re-derive.
export {
  DEFAULT_GOSSIP_INTERVAL_MS,
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_EXPLAIN_CAPACITY,
  PATH_TRAVERSAL_SEGMENTS,
  MAXIMUM_DRAW_ATTEMPTS,
} from './Constants.js';

export { Left, Right, left, right, eitherOf, eitherSequence } from './Either.js';
export type { Either } from './Either.js';

// HTML escaping primitives, not a markup sanitizer — the distinction their
// module header draws, and one a consumer has to keep too.
export { escapeHtml, SafeHtml, html, rawHtml } from './Html.js';

export { Lazy, lazy } from './Lazy.js';

export { lazyImportModule } from './LazyImport.js';
export type { LazyImportOptions } from './LazyImport.js';

export { Some, None, none, some, fromNullable, fromPredicate, firstSome } from './Option.js';
export type { Option } from './Option.js';

export { OptionsBuilder } from './OptionsBuilder.js';

// The one implementation of the project's options precedence — explicit
// options > HOCON > built-in defaults, where `undefined` on a higher layer
// means "not set" and falls through rather than shadowing.  AGENTS.md
// documents the rule by this function's name, so an application writing an
// options family in the same style needs the function itself.
export { mergeOptions, stripUndefined } from './OptionsMerge.js';

export { OptionsValidator, OptionsError } from './OptionsValidator.js';

export type { ProcessSignal } from './ProcessSignal.js';

export { randomString, randomHex, randomId, randomUuid } from './RandomString.js';
export type { RandomStringOptions, ExistsPredicate } from './RandomString.js';

export {
  redactUrlCredentials,
  redactedUrlLabel,
  redactErrorCredentials,
} from './RedactUrlCredentials.js';

export { RingBuffer } from './RingBuffer.js';

export { safeStringify } from './SafeStringify.js';

// Linear-time end-stripping.  The regex spelling of this is quadratic on a
// value a remote peer chooses (#1198), which is the reason it is a function
// at all rather than a one-liner at each site.
export { stripTrailing, stripSurrounding } from './StripCharacters.js';

export { TokenBucket } from './TokenBucket.js';
export type { TokenBucketOptions } from './TokenBucket.js';

export { Success, Failure, success, failure, tryOf, trySequence } from './Try.js';
export type { Try } from './Try.js';

export { wrapError } from './WrapError.js';
