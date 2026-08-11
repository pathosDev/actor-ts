/**
 * Minimal CBOR codec (RFC 8949 subset) used by `CborSerializer`.
 *
 * Supported major types:
 *   0 (unsigned int),
 *   1 (negative int),
 *   2 (byte string),
 *   3 (text string),
 *   4 (array),
 *   5 (map — with string keys when untagged, unrestricted under tag 259),
 *   6 (tagged item),
 *   7 (simple values: false/true/null/undefined + half/single/double float).
 *
 * Additional-info values 0–27 are handled for every major type; indefinite-
 * length items are not, the target use case being actor message
 * serialisation rather than arbitrary CBOR interop.
 *
 * The rich types carry the same set the `JsonTree` walker does, because the
 * two are interchangeable — a store's `withSerializer`, the serialization
 * extension default, HTTP content negotiation — and a payload must not
 * change shape depending on which one handled it (#1036).  Registered tags
 * are used wherever one fits the type faithfully (1 date, 2/3 bignum, 32
 * URI, 258 set, 259 map); everything else goes under tag 27, the generic
 * "type name plus constructor arguments" object.
 *
 * Unlike the JSON tree, this format needs no escape hatch for user data that
 * looks like a tag: a tag is its own major type here, so nothing a user can
 * put in a map or an array can be mistaken for one.
 */

import { BidirectionalMap } from '../util/BidirectionalMap.js';
import {
  binaryBytesOf,
  binaryKindOf,
  isBinaryKind,
  rebuildBinaryView,
  rebuildError,
} from './RichTypes.js';

export class CborEncodeError extends Error {
  constructor(message: string) { super(message); this.name = 'CborEncodeError'; }
}
export class CborDecodeError extends Error {
  constructor(message: string) { super(message); this.name = 'CborDecodeError'; }
}

const TAG_DATETIME = 0;      // RFC 8949: standard date/time string
const TAG_EPOCH_DATETIME = 1; // RFC 8949: epoch-based date/time
const TAG_UNSIGNED_BIGNUM = 2;
const TAG_NEGATIVE_BIGNUM = 3;
/**
 * IANA: "Serialised language-independent object with type name and
 * constructor arguments" — `27([name, ...arguments])`.
 *
 * The home for every rich type no registered tag describes faithfully.  One
 * mechanism rather than a set of squatted numbers out of the unassigned
 * ranges: a third-party reader sees the class name instead of a mystery, and
 * nothing here depends on IANA never handing those numbers to someone else.
 */
const TAG_GENERIC_OBJECT = 27;
/** IANA: "URI" — the href as a text string. */
const TAG_URI = 32;
/** IANA: "Mathematical finite set" — an array of the members. */
const TAG_SET = 258;
/**
 * IANA: "Map datatype with key-value operations" — a native CBOR map (major
 * type 5) whose keys are unrestricted.
 *
 * A `Map` cannot go on the wire untagged even though CBOR has a native map
 * type, because that is exactly what a plain object encodes to: the decoder
 * would have no way to tell the two apart, and reading every major-5 map back
 * as a `Map` would change the type of every ordinary payload (#1036).
 */
const TAG_MAP = 259;

/**
 * Ceiling on container nesting, enforced by BOTH halves of the codec.  The
 * decoder recurses once per array, map and tag level, so without a bound a
 * couple of hundred KB of `0x81` bytes exhausts the JS stack (#618); the
 * encoder measures the same levels so it cannot write something its own
 * decoder would refuse (#1036).  Real payloads are shallow; anything near
 * this is malformed or hostile.
 */
const MAX_NESTING_DEPTH = 256;

/* ================================ Encoder ================================= */

export class CborEncoder {
  private chunks: number[] = [];
  /**
   * Containers on the path from the root to the current node.  Revisiting one
   * is a cycle, reported as a `CborEncodeError` instead of overflowing the
   * stack.  Siblings sharing a reference (a DAG) are fine and get duplicated,
   * same as `JSON.stringify` and the JSON tree.
   */
  private ancestors = new Set<object>();

  encode(value: unknown): Uint8Array {
    this.chunks = [];
    this.ancestors.clear();
    this.writeValue(value, 0);
    return new Uint8Array(this.chunks);
  }

  /**
   * `depth` counts the levels the DECODER will spend on this value, not the
   * levels of user structure — a container that decodes through more than one
   * nested item charges more than one.  Both sides then measure the same
   * thing against `MAX_NESTING_DEPTH`, so "the encoder accepts it" and "the
   * decoder accepts it" cannot come apart; without that, a node can write a
   * snapshot it is unable to read back (#1036).
   *
   * `allowToJson` is false only for the value a `toJSON()` call returned —
   * see `writeObject`.
   */
  private writeValue(value: unknown, depth: number, allowToJson = true): void {
    if (depth > MAX_NESTING_DEPTH) {
      throw new CborEncodeError(`CBOR nesting deeper than ${MAX_NESTING_DEPTH}`);
    }
    if (value === null) return this.writeSimple(22); // null
    // CBOR has a simple value for `undefined` of its own, and the decoder has
    // always read it — the encoder was the only side flattening it to `null`,
    // which is a different value (#1036).
    if (value === undefined) return this.writeSimple(23);
    if (typeof value === 'boolean') return this.writeSimple(value ? 21 : 20);
    if (typeof value === 'number') {
      // `-0` ahead of the integer branch: `Number.isInteger(-0)` is true and
      // `writeInt` masks the sign away, so it used to come back as `+0`.  A
      // float64 carries the sign bit; the JSON tree carries it as
      // `{"__number__":"-0"}`, and the two must agree (#1036).
      if (Object.is(value, -0)) return this.writeDouble(value);
      if (Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
        return this.writeInt(value);
      }
      return this.writeDouble(value);
    }
    if (typeof value === 'bigint') {
      this.requireDepth(depth + 1);
      return this.writeBigInt(value);
    }
    if (typeof value === 'string') return this.writeString(value);
    if (value instanceof Uint8Array) return this.writeBytes(value);
    if (value instanceof Date) {
      this.requireDepth(depth + 1);
      this.writeTag(TAG_EPOCH_DATETIME);
      this.writeDouble(value.getTime() / 1000);
      return;
    }
    // Ahead of the `Map` branch on purpose.  `BidirectionalMap` only
    // implements the interface today, so `instanceof Map` does not catch it —
    // but if that ever changes, the wrong branch would silently start
    // dropping the class.
    if (value instanceof BidirectionalMap) return this.writeBidirectionalMap(value, depth);
    if (value instanceof Map) return this.writeMap(value, depth);
    if (value instanceof Set) return this.writeSet(value, depth);
    // After the `Uint8Array` branch above, which keeps its bare byte string.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return this.writeBinaryView(value, depth);
    }
    if (value instanceof RegExp) return this.writeRegExp(value, depth);
    // Before any `toJSON` handling: `URL.prototype.toJSON` would collapse it
    // to a bare string.
    if (value instanceof URL) {
      this.requireDepth(depth + 1);
      this.writeTag(TAG_URI);
      return this.writeString(value.href);
    }
    if (value instanceof Error) return this.writeError(value, depth);
    if (value instanceof Number || value instanceof String || value instanceof Boolean) {
      // Wrapper objects unwrap like `JSON.stringify` does.  Left to the
      // generic branch, `Object.entries(new String('ab'))` would write
      // `{"0":"a","1":"b"}`.
      return this.writeValue(value.valueOf(), depth, false);
    }
    if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
      // Inherently non-serialisable — refuse loudly instead of storing `{}`,
      // which is what `Object.entries` produces for all three (#1036).
      throw new CborEncodeError(`Cannot encode a ${value.constructor.name}`);
    }
    if (Array.isArray(value)) return this.writeArray(value, depth);
    if (typeof value === 'object') return this.writeObject(value, depth, allowToJson);
    throw new CborEncodeError(`Cannot encode value of type ${typeof value}`);
  }

  private writeArray(values: ReadonlyArray<unknown>, depth: number): void {
    this.enterContainer(values);
    try {
      this.writeHeader(4, values.length);
      for (const item of values) this.writeValue(item, depth + 1);
    } finally {
      this.ancestors.delete(values);
    }
  }

  /**
   * Tag 259 over a native CBOR map, so the entries cost the same bytes a
   * plain object's would and the keys stay unrestricted — the compactness
   * that is the reason to pick CBOR at all is kept.  One decode level, same
   * as a plain object: the reader consumes the tag and the map together.
   */
  private writeMap(map: ReadonlyMap<unknown, unknown>, depth: number): void {
    this.enterContainer(map);
    try {
      this.writeMapBody(map, map.size, depth);
    } finally {
      this.ancestors.delete(map);
    }
  }

  /**
   * The tag-259 map itself, without the cycle bookkeeping — `BidirectionalMap`
   * writes the same body under its own wrapper and must not re-register a
   * container it has already entered, or it would report itself as a cycle.
   */
  private writeMapBody(
    entries: Iterable<readonly [unknown, unknown]>,
    size: number,
    depth: number,
  ): void {
    this.writeTag(TAG_MAP);
    this.writeHeader(5, size);
    for (const [key, entryValue] of entries) {
      this.writeValue(key, depth + 1);
      this.writeValue(entryValue, depth + 1);
    }
  }

  /**
   * `27(["BidirectionalMap", 259(<map>)])` — the class name plus the single
   * constructor argument `new BidirectionalMap(entries)` actually takes, so
   * the body literally IS a `Map` and composes with the tag-259 reader.
   *
   * Only the forward direction goes out.  The reverse is fully determined by
   * it, so writing both would double the payload and hand a decoder two
   * sources of truth to disagree about; the constructor rebuilds the inverse.
   *
   * Three decode levels down to the entries — the tag, the argument array,
   * and the tag-259 map inside it.
   */
  private writeBidirectionalMap(map: BidirectionalMap<unknown, unknown>, depth: number): void {
    this.requireDepth(depth + 2);
    this.enterContainer(map);
    try {
      this.writeTag(TAG_GENERIC_OBJECT);
      this.writeHeader(4, 2);
      this.writeString('BidirectionalMap');
      this.writeMapBody(map.entries(), map.size, depth + 2);
    } finally {
      this.ancestors.delete(map);
    }
  }

  /**
   * Tag 258 over an array of the members.  Two decode levels, not one: the
   * reader spends one on the tag and one on the array inside it, and the
   * encoder has to charge what the decoder will spend.
   */
  private writeSet(set: ReadonlySet<unknown>, depth: number): void {
    this.requireDepth(depth + 1);
    this.enterContainer(set);
    try {
      this.writeTag(TAG_SET);
      this.writeHeader(4, set.size);
      for (const member of set) this.writeValue(member, depth + 2);
    } finally {
      this.ancestors.delete(set);
    }
  }

  /**
   * `27(["RegExp", source, flags])` — three elements, because tag 27's array
   * is `[name, ...constructor arguments]` and `new RegExp(source, flags)`
   * takes two.
   *
   * Not the registered tag 35: its content model is a bare text string with
   * nowhere to put the flags, and folding `/source/flags` into one string is
   * ambiguous the moment the source contains a slash.
   *
   * `lastIndex` is a transient cursor, not data — deliberately not carried.
   */
  /**
   * `27([kind, <byte string>])`, using the same `kind` names the JSON tree
   * stores under `__typedarray__` — both formats read one shared table, so
   * they cannot come to disagree about what a `Float64Array` is called.
   *
   * Not RFC 8746's registered tags 64–87, and that is a deliberate call.
   * They fit the numeric views well, but `DataView` and `ArrayBuffer` have no
   * tag there and would need a second mechanism regardless; `Uint8Array`
   * already travels as a bare byte string, so tag 64 would be a third
   * spelling of the same bytes; and 8746 forces an explicit big/little-endian
   * choice, i.e. a CBOR-only endianness table with no counterpart on the JSON
   * side — a second source of truth in the one place this issue is about.
   *
   * The bytes are the view's own, in platform order.  Every runtime this
   * project supports is little-endian, and the JSON tree has assumed the same
   * since it gained `__typedarray__`; it is written down here because it is
   * the one thing that would have to change to talk to a big-endian peer.
   */
  private writeBinaryView(value: ArrayBufferView | ArrayBuffer, depth: number): void {
    const kind = binaryKindOf(value);
    if (kind === undefined) {
      // An exotic ArrayBuffer view we cannot reconstruct — refuse rather than guess.
      throw new CborEncodeError(`Cannot encode binary view ${value.constructor?.name ?? 'unknown'}`);
    }
    this.requireDepth(depth + 2);
    this.writeTag(TAG_GENERIC_OBJECT);
    this.writeHeader(4, 2);
    this.writeString(kind);
    this.writeBytes(binaryBytesOf(value));
  }

  private writeRegExp(pattern: RegExp, depth: number): void {
    this.requireDepth(depth + 2);
    this.writeTag(TAG_GENERIC_OBJECT);
    this.writeHeader(4, 3);
    this.writeString('RegExp');
    this.writeString(pattern.source);
    this.writeString(pattern.flags);
  }

  /**
   * `27(["Error", {name, message, cause?, errors?}])` — one options-bag
   * argument rather than positional ones, so the payload is the same shape
   * the JSON tree's `__error__` carries and the two cannot come to describe
   * an error differently.
   *
   * The stack is deliberately absent: a persisted stack leaks filesystem
   * layout into long-lived rows, and a replayed one would lie about where
   * the error was thrown.
   *
   * Three decode levels down to `cause` — the tag, the argument array, and
   * the payload map.
   */
  private writeError(error: Error, depth: number): void {
    // Three, not two: the payload map always carries `name` and `message`,
    // which the decoder reads a level below the map itself.
    this.requireDepth(depth + 3);
    this.enterContainer(error);
    try {
      const cause = (error as { cause?: unknown }).cause;
      const errors = (error as { errors?: unknown }).errors;
      // `AggregateError` carries its member errors in `errors`.
      const hasErrors = Array.isArray(errors);

      this.writeTag(TAG_GENERIC_OBJECT);
      this.writeHeader(4, 2);
      this.writeString('Error');
      this.writeHeader(5, 2 + (cause !== undefined ? 1 : 0) + (hasErrors ? 1 : 0));
      this.writeString('name');
      this.writeString(error.name);
      this.writeString('message');
      this.writeString(error.message);
      if (cause !== undefined) {
        this.writeString('cause');
        this.writeValue(cause, depth + 3);
      }
      if (hasErrors) {
        this.writeString('errors');
        this.writeValue(errors, depth + 3);
      }
    } finally {
      this.ancestors.delete(error);
    }
  }

  private writeObject(value: object, depth: number, allowToJson: boolean): void {
    if (allowToJson) {
      const toJson = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJson === 'function') {
        // Honour `toJSON()` the way `JSON.stringify` and the JSON tree do.
        // The two serializers are interchangeable — the extension default, a
        // store's `withSerializer`, HTTP content negotiation — so the same
        // endpoint answering `application/json` and `application/cbor` must
        // not return two different shapes for a type that defines one.
        //
        // Per spec the RESULT is not probed again at this node.  That is what
        // stops `toJSON: () => this` recursing forever: the second pass falls
        // through to the loop below, meets the own `toJSON` function property
        // and refuses it as an unencodable type.  Values nested inside the
        // result get the normal treatment.
        //
        // The probe lives here, dead last in the dispatch, on purpose: every
        // rich type with a `toJSON` of its own — `Date`, `URL`,
        // `BidirectionalMap`, `Buffer` — has already been claimed by its own
        // branch above and is safe by construction.
        return this.writeValue((value as { toJSON: () => unknown }).toJSON(), depth, false);
      }
    }
    this.enterContainer(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>);
      this.writeHeader(5, entries.length);
      for (const [key, entryValue] of entries) {
        this.writeString(key);
        this.writeValue(entryValue, depth + 1);
      }
    } finally {
      this.ancestors.delete(value);
    }
  }

  /**
   * Assert a level the writer itself will occupy is inside the ceiling.
   *
   * `writeValue` only checks the level a value STARTS at, which is enough for
   * an array or a plain map — they are one item, and their children are
   * checked by their own `writeValue`.  It is not enough for the tagged
   * forms: `27([…])` puts its payload two levels down, so a value that
   * starts just inside the bound can still decode past it.  Where the writer
   * recurses, the child's check would catch that; where it does not — an
   * empty `Set`, a `RegExp`, an `Error` with no cause — nothing would.
   */
  private requireDepth(depth: number): void {
    if (depth > MAX_NESTING_DEPTH) {
      throw new CborEncodeError(`CBOR nesting deeper than ${MAX_NESTING_DEPTH}`);
    }
  }

  private enterContainer(container: object): void {
    if (this.ancestors.has(container)) {
      throw new CborEncodeError('Cannot encode a circular reference');
    }
    this.ancestors.add(container);
  }

  private writeInt(value: number): void {
    if (value >= 0) this.writeHeader(0, value);
    else this.writeHeader(1, -value - 1);
  }

  private writeBigInt(value: bigint): void {
    // Use RFC 8949 bignum tags so the decoder can reconstruct a bigint.
    const positive = value >= 0n;
    const absVal = positive ? value : -value - 1n;
    this.writeTag(positive ? TAG_UNSIGNED_BIGNUM : TAG_NEGATIVE_BIGNUM);
    const bytes = bigIntToBytes(absVal);
    this.writeHeader(2, bytes.length);
    for (const byte of bytes) this.chunks.push(byte);
  }

  private writeString(text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.writeHeader(3, bytes.length);
    for (const byte of bytes) this.chunks.push(byte);
  }

  private writeBytes(bytes: Uint8Array): void {
    this.writeHeader(2, bytes.length);
    for (const byte of bytes) this.chunks.push(byte);
  }

  private writeTag(tag: number): void {
    this.writeHeader(6, tag);
  }

  private writeSimple(value: number): void {
    this.chunks.push((7 << 5) | value);
  }

  private writeDouble(value: number): void {
    this.chunks.push((7 << 5) | 27);
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, false);
    for (const byte of new Uint8Array(buffer)) this.chunks.push(byte);
  }

  private writeHeader(major: number, value: number): void {
    const mj = (major & 0x7) << 5;
    if (value < 24) {
      this.chunks.push(mj | value);
    } else if (value < 0x100) {
      this.chunks.push(mj | 24, value);
    } else if (value < 0x10000) {
      this.chunks.push(mj | 25, (value >>> 8) & 0xff, value & 0xff);
    } else if (value < 0x100000000) {
      this.chunks.push(
        mj | 26,
        (value >>> 24) & 0xff, (value >>> 16) & 0xff,
        (value >>> 8) & 0xff, value & 0xff,
      );
    } else {
      // Fall back to 8-byte form via BigInt math.
      this.chunks.push(mj | 27);
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, BigInt(value), false);
      for (let i = 0; i < 8; i++) this.chunks.push(view.getUint8(i));
    }
  }
}

/* ================================ Decoder ================================= */

/**
 * Ceiling on the byte length of a tag 2 / tag 3 bignum magnitude, i.e.
 * 8192-bit integers.  Comfortably above anything a real message carries — an
 * RSA-4096 modulus is 512 bytes — and the cost of rebuilding one is now
 * linear anyway, so this is a backstop rather than the fix.
 */
const MAX_BIGNUM_BYTES = 1024;

export class CborDecoder {
  private pos = 0;
  private bytes!: Uint8Array;
  private view!: DataView;

  decode(bytes: Uint8Array): unknown {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    const value = this.readValue(0);
    if (this.pos !== bytes.byteLength) {
      throw new CborDecodeError(`Trailing CBOR bytes at offset ${this.pos}`);
    }
    return value;
  }

  /**
   * `depth` is threaded through rather than kept as a field so it unwinds
   * with the call stack — there is no cleanup to forget on the many early
   * returns and throws below.
   */
  private readValue(depth: number): unknown {
    if (depth > MAX_NESTING_DEPTH) {
      throw new CborDecodeError(`CBOR nesting deeper than ${MAX_NESTING_DEPTH} at offset ${this.pos}`);
    }
    if (this.pos >= this.bytes.byteLength) {
      throw new CborDecodeError(`Unexpected end of input at offset ${this.pos}`);
    }
    const ib = this.bytes[this.pos]!;
    const major = (ib >>> 5) & 0x7;
    const add = ib & 0x1f;
    this.pos++;

    // Major type 7 has its own additional-info interpretation (simple values
    // and floats).  Don't run it through `readLength`, which would consume
    // the float's own bytes as if they were a length prefix.
    if (major === 7) return this.readSimple(add);

    const len = this.readLength(add);

    switch (major) {
      case 0: return typeof len === 'bigint' ? len : Number(len);
      case 1: {
        const value = typeof len === 'bigint' ? -(len as bigint) - 1n : -Number(len) - 1;
        return value;
      }
      case 2: return this.readBytes(Number(len));
      case 3: return new TextDecoder().decode(this.readBytes(Number(len)));
      case 4: {
        const out: unknown[] = [];
        const count = Number(len);
        for (let i = 0; i < count; i++) out.push(this.readValue(depth + 1));
        return out;
      }
      case 5: {
        const out: Record<string, unknown> = {};
        const count = Number(len);
        for (let i = 0; i < count; i++) {
          const key = this.readValue(depth + 1);
          const value = this.readValue(depth + 1);
          if (typeof key !== 'string') {
            // Stays a hard error even though the codec can plainly handle
            // non-string keys now (see `readEntryPairs`).  Falling back to a
            // `Map` here would make the decoded TYPE depend on the data: the
            // same message would arrive as an object when its keys happened
            // to be strings and as a `Map` when one of them was not.
            throw new CborDecodeError('Only string keys are supported in maps');
          }
          // `defineProperty`, not `out[key] = value`: assignment consults the
          // prototype chain, so a `"__proto__"` key from the wire would reach
          // `Object.prototype`'s setter and re-parent the decoded object
          // instead of becoming a field on it (#581).  Defining the property
          // ignores setters, so the key stays data — the value survives the
          // round-trip rather than being rejected or silently dropped.
          Object.defineProperty(out, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return out;
      }
      case 6: return this.readTagged(Number(len), depth);
      default:
        throw new CborDecodeError(`Unknown major type ${major}`);
    }
  }

  /**
   * Tag 259 is handled BEFORE its body is read.  Letting `readValue` take it
   * would hand the body to the major-5 reader, which builds a plain object
   * and rejects non-string keys — right for an untagged map, wrong here: a
   * `Map` carries whatever keys it likes, and a `'__proto__'` key inside one
   * reaches no setter, so the hardening that rule exists for (#581) has
   * nothing to protect.
   *
   * Every other tag reads its body normally and is interpreted by `applyTag`.
   */
  private readTagged(tag: number, depth: number): unknown {
    if (tag === TAG_MAP) return new Map(this.readEntryPairs(depth));
    const inner = this.readValue(depth + 1);
    if (tag === TAG_GENERIC_OBJECT) return this.readGenericObject(inner);
    return this.applyTag(tag, inner);
  }

  /**
   * Rebuild a `27([name, ...arguments])` object.  Names are dispatched
   * through a fixed allow-list and never resolved dynamically — a payload
   * must not be able to name an arbitrary global and have it constructed.
   *
   * An unknown name passes the decoded array through instead of throwing,
   * the same way an unknown tag does.  A newer node writing a class an older
   * one has never heard of then degrades to plain data on the old node
   * rather than failing the whole message, which is what a rolling cluster
   * upgrade needs.
   */
  private readGenericObject(inner: unknown): unknown {
    if (!Array.isArray(inner) || inner.length < 1 || typeof inner[0] !== 'string') {
      throw new CborDecodeError(`Tag ${TAG_GENERIC_OBJECT} expects [name, ...arguments]`);
    }
    const [name, ...args] = inner as [string, ...unknown[]];
    switch (name) {
      case 'BidirectionalMap': return buildBidirectionalMap(args);
      case 'RegExp': return buildRegExp(args);
      case 'Error': return buildError(args);
      default:
        // A binary kind is a name we DO know, so a bad payload under it is an
        // error rather than something to pass through.
        return isBinaryKind(name) ? buildBinaryView(name, args) : inner;
    }
  }

  /**
   * A major-5 map read as entry pairs, keys unrestricted.  Because it reads
   * the header itself it has to repeat the guards `readValue`'s preamble
   * owns: the depth ceiling, end of input, and that the item really is a map
   * — `259("nope")` must fail rather than be misread.  Indefinite-length
   * comes for free, since `readLength` rejects additional info 31.
   *
   * Nothing is pre-allocated: `readLength` can report up to 2^64-1, and
   * `new Array(count)` on that is an instant out-of-memory.  Pushing instead
   * means a truncated payload dies on the first `readValue` past the end,
   * which is the same way `case 4` stays safe.
   */
  private readEntryPairs(depth: number): Array<[unknown, unknown]> {
    if (depth > MAX_NESTING_DEPTH) {
      throw new CborDecodeError(`CBOR nesting deeper than ${MAX_NESTING_DEPTH} at offset ${this.pos}`);
    }
    if (this.pos >= this.bytes.byteLength) {
      throw new CborDecodeError(`Unexpected end of input at offset ${this.pos}`);
    }
    const ib = this.bytes[this.pos]!;
    if (((ib >>> 5) & 0x7) !== 5) {
      throw new CborDecodeError(`Tag ${TAG_MAP} expects a map at offset ${this.pos}`);
    }
    this.pos++;
    const count = Number(this.readLength(ib & 0x1f));
    const pairs: Array<[unknown, unknown]> = [];
    for (let i = 0; i < count; i++) {
      pairs.push([this.readValue(depth + 1), this.readValue(depth + 1)]);
    }
    return pairs;
  }

  private readLength(add: number): number | bigint {
    if (add < 24) return add;
    if (add === 24) return this.readUint(1);
    if (add === 25) return this.readUint(2);
    if (add === 26) return this.readUint(4);
    if (add === 27) return this.readUint(8);
    throw new CborDecodeError(`Unsupported additional info ${add}`);
  }

  private readUint(byteLen: number): number | bigint {
    if (this.pos + byteLen > this.bytes.byteLength) {
      throw new CborDecodeError(`Truncated input: need ${byteLen} bytes at offset ${this.pos}`);
    }
    let out = 0n;
    for (let i = 0; i < byteLen; i++) {
      out = (out << 8n) | BigInt(this.bytes[this.pos + i]!);
    }
    this.pos += byteLen;
    return out <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(out) : out;
  }

  private readBytes(count: number): Uint8Array {
    if (this.pos + count > this.bytes.byteLength) {
      throw new CborDecodeError(`Truncated input: need ${count} bytes at offset ${this.pos}`);
    }
    const out = this.bytes.slice(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  private readSimple(add: number): unknown {
    if (add === 20) return false;
    if (add === 21) return true;
    if (add === 22) return null;
    if (add === 23) return undefined;
    if (add === 25) return this.readHalfFloat();
    if (add === 26) {
      if (this.pos + 4 > this.bytes.byteLength) throw new CborDecodeError('Truncated float32');
      const value = this.view.getFloat32(this.pos, false);
      this.pos += 4;
      return value;
    }
    if (add === 27) {
      if (this.pos + 8 > this.bytes.byteLength) throw new CborDecodeError('Truncated float64');
      const value = this.view.getFloat64(this.pos, false);
      this.pos += 8;
      return value;
    }
    throw new CborDecodeError(`Unsupported simple value ${add}`);
  }

  private readHalfFloat(): number {
    if (this.pos + 2 > this.bytes.byteLength) throw new CborDecodeError('Truncated float16');
    const hi = this.bytes[this.pos]!, lo = this.bytes[this.pos + 1]!;
    this.pos += 2;
    const sign = (hi & 0x80) ? -1 : 1;
    const exp = (hi & 0x7c) >>> 2;
    const mant = ((hi & 0x03) << 8) | lo;
    if (exp === 0) return sign * Math.pow(2, -14) * (mant / 1024);
    if (exp === 0x1f) return mant ? NaN : sign * Infinity;
    return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
  }

  private applyTag(tag: number, inner: unknown): unknown {
    switch (tag) {
      case TAG_DATETIME:
        if (typeof inner === 'string') return new Date(inner);
        throw new CborDecodeError('Tag 0 expects a string');
      case TAG_EPOCH_DATETIME:
        if (typeof inner === 'number') return new Date(inner * 1000);
        throw new CborDecodeError('Tag 1 expects a number');
      case TAG_UNSIGNED_BIGNUM:
      case TAG_NEGATIVE_BIGNUM: {
        if (!(inner instanceof Uint8Array)) {
          throw new CborDecodeError(`Tag ${tag} expects a byte string`);
        }
        if (inner.byteLength > MAX_BIGNUM_BYTES) {
          throw new CborDecodeError(
            `Tag ${tag} bignum is ${inner.byteLength} bytes, over the ${MAX_BIGNUM_BYTES}-byte limit`,
          );
        }
        const magnitude = bytesToBigInt(inner);
        return tag === TAG_UNSIGNED_BIGNUM ? magnitude : -1n - magnitude;
      }
      case TAG_URI: {
        if (typeof inner !== 'string') throw new CborDecodeError(`Tag ${TAG_URI} expects a string`);
        try {
          return new URL(inner);
        } catch {
          throw new CborDecodeError(`Tag ${TAG_URI} expects an absolute URL (got '${inner}')`);
        }
      }
      case TAG_SET:
        // Without the check `new Set('abc')` would happily produce a set of
        // three characters — silent garbage rather than a rejected payload.
        if (!Array.isArray(inner)) throw new CborDecodeError(`Tag ${TAG_SET} expects an array`);
        return new Set(inner);
      default:
        // Unknown tag — pass the inner value through.
        return inner;
    }
  }
}

/* ------------------------ Generic-object constructors ---------------------- */

/**
 * The argument is the tag-259 map the encoder wrote, so it arrives as a real
 * `Map`.  Its constructor regenerates the reverse index, which is why a row
 * that somehow carries a duplicate value resolves last-wins instead of
 * restoring a map whose two halves disagree.
 */
function buildBidirectionalMap(args: readonly unknown[]): BidirectionalMap<unknown, unknown> {
  const entries = args[0];
  if (!(entries instanceof Map)) {
    throw new CborDecodeError('BidirectionalMap expects a map of entries');
  }
  return new BidirectionalMap(entries);
}

function buildBinaryView(kind: string, args: readonly unknown[]): ArrayBufferView | ArrayBuffer {
  const bytes = args[0];
  if (!(bytes instanceof Uint8Array)) {
    throw new CborDecodeError(`${kind} expects a byte string`);
  }
  const view = rebuildBinaryView(kind, bytes);
  if (view === undefined) {
    throw new CborDecodeError(`${kind} cannot be built from ${bytes.byteLength} bytes`);
  }
  return view;
}

function buildRegExp(args: readonly unknown[]): RegExp {
  const [source, flags] = args;
  if (typeof source !== 'string' || typeof flags !== 'string') {
    throw new CborDecodeError('RegExp expects a source string and a flags string');
  }
  // Well-typed but still unbuildable — an unbalanced source or a bogus flag
  // set.  Report it as a decode error rather than letting a raw SyntaxError
  // out, which would name neither the tag nor the payload.
  try {
    return new RegExp(source, flags);
  } catch {
    throw new CborDecodeError(`RegExp cannot be built from /${source}/${flags}`);
  }
}

function buildError(args: readonly unknown[]): Error {
  const payload = args[0];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CborDecodeError('Error expects a { name, message } object');
  }
  const fields = payload as { name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof fields.name !== 'string' || typeof fields.message !== 'string') {
    throw new CborDecodeError('Error expects a { name, message } object');
  }
  const errors = Array.isArray(fields.errors) ? fields.errors : undefined;
  const out = rebuildError(fields.name, fields.message, errors);
  // Key presence, not the value: a cause that IS `undefined` is different
  // from no cause at all, and CBOR can tell them apart.
  if ('cause' in fields) (out as { cause?: unknown }).cause = fields.cause;
  return out;
}

/* --------------------------- BigInt ↔ bytes utilities ---------------------- */

function bigIntToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  const bytes: number[] = [];
  let value = n;
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Rebuild a bignum magnitude from its big-endian bytes.
 *
 * Parses the whole magnitude in one `BigInt('0x…')` rather than shifting a
 * byte in at a time.  The obvious loop — `value = (value << 8n) | BigInt(b)`
 * — reallocates and copies the entire accumulated bignum on every iteration,
 * so it costs O(n²) in the byte count and a few hundred KB of tag-2 payload
 * blocks the event loop for tens of seconds (#567).
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.byteLength === 0) return 0n;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return BigInt(`0x${hex}`);
}
