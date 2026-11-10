import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';
import { MAX_NESTING_DEPTH } from './Constants.js';

/**
 * Ceilings a decoder applies to bytes this process READS — the shape behind
 * `actor-ts.serialization.read-constraints.*`.
 *
 * They exist because the read side is the only side an attacker controls.  A
 * peer that completes the cluster handshake, or any client whose body reaches
 * a serializer, chooses the bytes; this node chooses how much work it will do
 * on them before giving up.  Nothing here changes what this node WRITES, so
 * lowering a ceiling makes this node stricter than its own encoder rather than
 * altering the wire format — which is why {@link ReadConstraintsOptionsValidator}
 * refuses a nesting depth *above* the encoder's own hard cap and allows any
 * value below it.
 *
 * Two things are deliberately outside the contract:
 *
 *   - **The persistence `PayloadCodec`.**  Those bytes were written by this
 *     framework into its own journal; a row that stops decoding is a recovery
 *     failure, not an attack, and a ceiling there would turn a tightened
 *     config into unreadable history.
 *   - **The HTTP body edge.**  `Marshalling` builds its serializers inline
 *     with no `ActorSystem` handle to read config through, so an HTTP decode
 *     inherits nothing from here.  Giving it that seam is #967; inventing a
 *     second one here would duplicate it.
 *
 * A codec added later inherits this contract rather than re-deciding it.
 */
export type ReadConstraintsOptionsType = {
  /**
   * Container levels a decoder will descend before refusing the payload.
   *
   * Both codecs recurse once per array / map / tag level and neither input is
   * trusted, so this is the ceiling that keeps a few hundred KB of nesting
   * from exhausting the JS stack.  On the JSON side that is the WHOLE
   * protection, and the engine supplies none of it: measured by
   * `tests/smoke/cases/35-decoder-read-constraints.mjs`, `JSON.parse` accepts
   * 100 000 levels of `[` on Bun, Node and Deno alike — JSC and V8 both — so
   * the recursion that overflows is the project's own walker in `JsonTree.ts`
   * and nothing upstream of it ever objected (#880).
   *
   * Bounded above by {@link MAX_NESTING_DEPTH}, the encoder's hard cap, so the
   * two halves can be brought closer together but never pulled apart: a node
   * that read deeper than it writes would accept frames it cannot produce, the
   * invariant #1036 exists to hold.  Real payloads are shallow — anything near
   * the default is malformed or hostile.
   *
   * Default: {@link DEFAULT_MAX_NESTING_DEPTH}.
   */
  readonly maxNestingDepth?: number;
  /**
   * Ceiling in bytes on one document handed to `JsonSerializer.fromBinary` or
   * `CborSerializer.fromBinary`, checked before the bytes are parsed.  `0`
   * removes it.
   *
   * `0` is the shipped default because on every path the framework owns,
   * something already bounds the byte count: the cluster wire rejects a frame
   * past `actor-ts.remote.max-frame-bytes` on its 4-byte length prefix, and an
   * HTTP body is bounded by the server's own body cap.  This is the knob for a
   * deployment whose serializers are reached some other way — a broker payload,
   * a queue message — where nothing upstream has an opinion.
   *
   * Default: {@link DEFAULT_MAX_DOCUMENT_BYTES}.
   */
  readonly maxDocumentBytes?: number;
  /**
   * Ceiling in bytes on ONE CBOR byte string, text string or map key, checked
   * against the item's length prefix **before** those bytes are allocated.
   * `0` removes it.
   *
   * CBOR-only, and that asymmetry is the point rather than an omission: a CBOR
   * item announces its length, so refusing it costs nothing and prevents the
   * allocation, whereas by the time the JSON walker sees a string `JSON.parse`
   * has already materialised it and a ceiling would cost a comparison per node
   * while preventing nothing.  (It would also be measuring a different thing —
   * a JS string's `length` is UTF-16 code units, not the bytes this counts.)
   *
   * The default sits ABOVE `actor-ts.remote.max-frame-bytes` (16 MiB), so on
   * the cluster wire the frame cap is the effective ceiling and this one never
   * binds.  That is deliberate: it makes the shipped value inert on the path
   * that is already bounded, and leaves it meaningful on the paths that are
   * not.  Lower it where CBOR payloads are known to be small.
   *
   * Default: {@link DEFAULT_MAX_STRING_LENGTH}.
   */
  readonly maxStringLength?: number;
};

/**
 * Built-in default for {@link ReadConstraintsOptionsType.maxNestingDepth}, and
 * deliberately the encoder's own ceiling rather than a second number.
 *
 * Out of the box the two halves therefore measure the identical limit, which
 * is the state #1036 established and this key must not silently leave; a
 * deployment that wants a stricter reader lowers it, and the validator refuses
 * to let anything raise it.
 */
export const DEFAULT_MAX_NESTING_DEPTH = MAX_NESTING_DEPTH;

/**
 * Built-in default for {@link ReadConstraintsOptionsType.maxDocumentBytes} —
 * `0`, i.e. no ceiling of our own.
 *
 * `0` rather than `off`: the HOCON parser hands `off` back as the *string*
 * `'off'`, which `getBytes` rejects outright, so a boolean spelling would need
 * a second accessor to read one key.  `0` is the sentinel the rest of
 * `reference.conf` already uses (`sharding.max-entities`,
 * `distributed-data.max-gossip-bytes`, `http.shutdown-grace-period`).
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 0;

/**
 * Built-in default for {@link ReadConstraintsOptionsType.maxStringLength} —
 * 20 MiB, one step above `actor-ts.remote.max-frame-bytes` (16 MiB).
 *
 * Chosen so the shipped value cannot change what the cluster wire already
 * accepts: a CBOR string big enough to reach this ceiling cannot fit in a
 * frame that passes the frame cap, so nothing that decodes today stops
 * decoding. It is a backstop for the paths the frame cap does not cover, and a
 * starting point to lower rather than a number tuned to anything.
 */
export const DEFAULT_MAX_STRING_LENGTH = 20 * 1024 * 1024;

/**
 * Every ceiling resolved — the shape a decoder holds once a caller's options
 * have been layered over the built-in defaults.
 */
export const defaultReadConstraintsOptions: Required<ReadConstraintsOptionsType> = {
  maxNestingDepth: DEFAULT_MAX_NESTING_DEPTH,
  maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
  maxStringLength: DEFAULT_MAX_STRING_LENGTH,
};

/**
 * Fluent builder for {@link ReadConstraintsOptionsType}.
 *
 *     const readConstraints = ReadConstraintsOptions.create()
 *       .withMaxNestingDepth(64)
 *       .withMaxDocumentBytes(1024 * 1024);
 *     const serializer = new CborSerializer(readConstraints);
 */
export class ReadConstraintsOptionsBuilder extends OptionsBuilder<ReadConstraintsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ReadConstraintsOptionsBuilder()`. */
  static create(): ReadConstraintsOptionsBuilder {
    return new ReadConstraintsOptionsBuilder();
  }

  /** Container levels a decoder will descend.  Never above the encoder's cap. */
  withMaxNestingDepth(maxNestingDepth: number): this {
    return this.set('maxNestingDepth', maxNestingDepth);
  }

  /** Ceiling in bytes on one decoded document.  `0` removes it. */
  withMaxDocumentBytes(maxDocumentBytes: number): this {
    return this.set('maxDocumentBytes', maxDocumentBytes);
  }

  /** Ceiling in bytes on one CBOR string or map key.  `0` removes it. */
  withMaxStringLength(maxStringLength: number): this {
    return this.set('maxStringLength', maxStringLength);
  }
}

/** Validates resolved {@link ReadConstraintsOptionsType} settings. */
export class ReadConstraintsOptionsValidator extends OptionsValidator<ReadConstraintsOptionsType> {
  constructor() {
    super('ReadConstraintsOptions');
  }

  protected rules(s: Partial<ReadConstraintsOptionsType>): void {
    // Positive rather than non-negative: `0` levels would refuse every
    // container, so there is no "disabled" reading of it to preserve.
    this.positiveInt('maxNestingDepth');
    // Non-negative on the two byte ceilings — `0` is the documented "no
    // ceiling of our own" spelling, which this project prefers to `off`.
    this.nonNegativeInt('maxDocumentBytes');
    this.nonNegativeInt('maxStringLength');
    if (s.maxNestingDepth !== undefined && s.maxNestingDepth > MAX_NESTING_DEPTH) {
      this.fail(
        'maxNestingDepth',
        `must not exceed the encoder's own ceiling of ${MAX_NESTING_DEPTH}: a node that reads `
        + 'deeper than it writes would accept a payload it cannot produce (#1036)',
        s.maxNestingDepth,
      );
    }
  }
}

/**
 * Read `actor-ts.serialization.read-constraints.*` into the shape a consumer
 * layers under its explicit options.  Only keys actually present are returned,
 * so an absent one falls through to the built-in default instead of landing as
 * an explicit `undefined` — the rule `mergeOptions` encodes.
 */
export function readReadConstraintsOptionsFromConfig(
  config: Config,
): Partial<ReadConstraintsOptionsType> {
  const keys = ConfigKeys.serialization.readConstraints;
  const out: {
    -readonly [K in keyof ReadConstraintsOptionsType]?: ReadConstraintsOptionsType[K]
  } = {};
  if (config.hasPath(keys.maxNestingDepth)) {
    out.maxNestingDepth = config.getInt(keys.maxNestingDepth);
  }
  if (config.hasPath(keys.maxDocumentBytes)) {
    out.maxDocumentBytes = config.getBytes(keys.maxDocumentBytes);
  }
  if (config.hasPath(keys.maxStringLength)) {
    out.maxStringLength = config.getBytes(keys.maxStringLength);
  }
  return out;
}

/**
 * Accepted input wherever a decoder takes read constraints: the fluent
 * {@link ReadConstraintsOptionsBuilder} OR a plain
 * {@link ReadConstraintsOptionsType} object.
 */
export type ReadConstraintsOptions = ReadConstraintsOptionsBuilder | Partial<ReadConstraintsOptionsType>;
/** Value alias so `ReadConstraintsOptions.create()` resolves to the builder. */
export const ReadConstraintsOptions = ReadConstraintsOptionsBuilder;
