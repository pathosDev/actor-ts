import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';
import { JSON_TREE_TAG_NAMES, type JsonTreeTagName } from './Constants.js';

/**
 * What the cluster wire's decoder will build out of a peer's frame — the shape
 * behind `actor-ts.serialization.wire.*` (#1303).
 *
 * A frame has been a tagged JSON tree since #450, applied to the whole frame,
 * so a tag anywhere in a body is an instruction to construct a class.  The
 * frame is bytes a peer wrote, and before this the decoder followed every
 * instruction: a peer chose whether a value arrived as a `RegExp` it authored,
 * an `Error` subclass or an `undefined` no parse can produce.  This is the
 * allow-list that decides which instructions a node follows.
 *
 * Kept out of `ReadConstraintsOptions` deliberately.  Those ceilings apply to
 * every decoder in the process, `JsonSerializer` included, and
 * `JsonSerializer` is also what the persistence migration codec reads stored
 * rows with — an allow-list there would turn a tightened config into history
 * that no longer decodes.  This one reaches `FrameDecoder` and nothing else.
 */
export type WireDecodeOptionsType = {
  /**
   * The `JsonTree` tags a frame from a peer may use, by name.
   *
   * A frame that uses any other tag is **refused**: skipped, counted on its
   * decoder and logged with the tag's name, while the connection and the
   * frames batched beside it are kept.  Not delivered as a plain object
   * instead — the sender wrote the tagged format and meant a `RegExp`, so
   * handing the actor `{ __regexp__: … }` would change the value's class
   * without telling anyone.  `[]` decodes frames as plain JSON, with no key
   * special.
   *
   * Default: {@link DEFAULT_WIRE_ADMITTED_TAGS}.
   */
  readonly admittedTags?: readonly JsonTreeTagName[];
};

/**
 * Built-in default for {@link WireDecodeOptionsType.admittedTags}: the data
 * tags (maintainer decision D-2 on #1303).
 *
 * `date`, `bytes`, `typed-array`, `map`, `set` and `bigint` are the ones the
 * decision names.  `bidirectional-map` and `bidirectional-multi-map` are the
 * framework's own `Map`-shaped collections and rebuild through the same entry
 * pairs, and `number` — `NaN`, `±Infinity`, `-0` — builds no class at all: the
 * value stays `typeof 'number'`, and refusing it would refuse a metric frame
 * that plain JSON used to turn into `null`.
 *
 * Out: `regexp` (a peer-authored pattern, catastrophic backtracking included),
 * `undefined` (a value in a position `JSON.parse` never fills with one),
 * `error` (a class with a cause chain, picked by name) and `url` (a parsed
 * object where a string was sent).  A deployment that sends any of them across
 * nodes lists it again — on every node that receives it.
 */
export const DEFAULT_WIRE_ADMITTED_TAGS: readonly JsonTreeTagName[] = [
  'date', 'bytes', 'typed-array', 'map', 'set', 'bigint',
  'bidirectional-map', 'bidirectional-multi-map', 'number',
];

/** Every wire-decode setting resolved to its built-in default. */
export const defaultWireDecodeOptions: Required<WireDecodeOptionsType> = {
  admittedTags: DEFAULT_WIRE_ADMITTED_TAGS,
};

/**
 * Fluent builder for {@link WireDecodeOptionsType}.
 *
 *     const wireDecode = WireDecodeOptions.create()
 *       .withAdmittedTags([...DEFAULT_WIRE_ADMITTED_TAGS, 'error']);
 *     const transportOptions = TcpTransportOptions.create().withWireDecode(wireDecode);
 */
export class WireDecodeOptionsBuilder extends OptionsBuilder<WireDecodeOptionsType> {
  /** Start a fresh builder.  Equivalent to `new WireDecodeOptionsBuilder()`. */
  static create(): WireDecodeOptionsBuilder {
    return new WireDecodeOptionsBuilder();
  }

  /** The `JsonTree` tags a peer's frame may use.  `[]` is plain JSON. */
  withAdmittedTags(admittedTags: readonly JsonTreeTagName[]): this {
    return this.set('admittedTags', admittedTags);
  }
}

/** Validates resolved {@link WireDecodeOptionsType} settings. */
export class WireDecodeOptionsValidator extends OptionsValidator<WireDecodeOptionsType> {
  constructor() {
    super('WireDecodeOptions');
  }

  protected rules(s: Partial<WireDecodeOptionsType>): void {
    // Refused here rather than admitted as nothing: a misspelt `regex` that
    // silently admitted less than the operator asked for would surface as
    // frames refused for no visible reason, on another node, much later.
    const known: readonly string[] = JSON_TREE_TAG_NAMES;
    for (const tag of s.admittedTags ?? []) {
      if (!known.includes(tag)) {
        this.fail('admittedTags', `'${String(tag)}' is not a JsonTree tag name; expected one of ${known.join(', ')}`, tag);
      }
    }
  }
}

/**
 * Read `actor-ts.serialization.wire.*` into the shape a consumer layers under
 * its explicit options.  Only keys actually present are returned, so an absent
 * one falls through to the built-in default.  The names are checked where they
 * are consumed, by {@link WireDecodeOptionsValidator}, so HOCON and an explicit
 * option are refused by the same rule.
 */
export function readWireDecodeOptionsFromConfig(config: Config): Partial<WireDecodeOptionsType> {
  const keys = ConfigKeys.serialization.wire;
  if (!config.hasPath(keys.admittedTags)) return {};
  return { admittedTags: config.getStringList(keys.admittedTags) as JsonTreeTagName[] };
}

/**
 * Accepted input wherever the wire decode is configured: the fluent
 * {@link WireDecodeOptionsBuilder} OR a plain {@link WireDecodeOptionsType}.
 */
export type WireDecodeOptions = WireDecodeOptionsBuilder | WireDecodeOptionsType;
/** Value alias so `WireDecodeOptions.create()` resolves to the builder. */
export const WireDecodeOptions = WireDecodeOptionsBuilder;
