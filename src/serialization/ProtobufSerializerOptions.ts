import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { RESERVED_SERIALIZER_IDS_BELOW } from './Constants.js';

/** What `encode()` hands back — the writer whose `finish()` yields the bytes. */
export interface ProtobufWriter {
  /** Flush the accumulated fields and return the encoded bytes. */
  finish(): Uint8Array;
}

/** Conversion knobs passed to `toObject` when decoding to plain objects. */
export type ProtobufConversionOptions = {
  readonly defaults?: boolean;
  readonly longs?: unknown;
};

/**
 * The slice of a Protobuf message type that {@link ProtobufSerializer}
 * uses.  Declared structurally rather than imported from `protobufjs`,
 * the same call `zodCodec` makes with `ParserLike`: the schema belongs to
 * the user's project, so actor-ts neither pins a library version nor
 * lazily imports something it never calls itself.
 *
 * **Why a message type and not a `.proto` path.**  Loading `.proto` at
 * runtime would mean filesystem access — unavailable in a browser, behind
 * a permission prompt on Deno, and a deployment concern everywhere
 * (the file has to ship next to the bundle).  Taking the compiled type
 * pushes that choice to the user, who can reach it three ways without a
 * build step being mandatory:
 *
 *     // 1. parse a .proto source string at startup (no filesystem)
 *     const root = protobuf.parse(protoSource).root;
 *     const messageType = root.lookupType('Order');
 *
 *     // 2. a JSON descriptor bundled with the app
 *     const messageType = protobuf.Root.fromJSON(descriptor).lookupType('Order');
 *
 *     // 3. generated static code (pbjs, ts-proto) — shape matches too
 *     import { Order } from './generated/order.js';
 *
 * `verify` and `toObject` exist only on `protobufjs`'s reflection types,
 * so both are optional here and generated static code still fits.
 *
 * `decode` returns `unknown`, not `T`, on purpose.  A reflection `Type`
 * decodes to a dynamic `Message` that TypeScript cannot see the fields of,
 * so declaring `T` there would make `root.lookupType('Order')` — the
 * documented way to get a message type — fail to typecheck.  The cast to
 * `T` happens once, inside `fromBinary`, which is also where the plain-
 * object conversion decides what the value actually is.
 */
export interface ProtobufMessageType<T = unknown> {
  /** Encode a message into a writer; `finish()` produces the bytes. */
  encode(message: T): ProtobufWriter;
  /** Decode bytes back into a dynamic message. */
  decode(bytes: Uint8Array): unknown;
  /** Reflection only: returns a reason string when the message doesn't match the schema. */
  verify?(message: T): string | null;
  /** Reflection only: convert a decoded message into a plain object. */
  toObject?(message: unknown, options?: ProtobufConversionOptions): Record<string, unknown>;
  /** Fully-qualified message name, used as the default manifest when set. */
  readonly fullName?: string;
}

/** Plain options-object shape accepted by a {@link ProtobufSerializer}. */
export type ProtobufSerializerOptionsType<T = unknown> = {
  /** The compiled Protobuf message type that does the encoding.  Required. */
  readonly messageType: ProtobufMessageType<T>;
  /**
   * Wire identifier embedded in every frame.  Required, and must be
   * >= 100: 1–99 are reserved for the built-ins (JSON=1, CBOR=2).
   */
  readonly id: number;
  /** Diagnostic name shown in error messages.  Default `'protobuf'`. */
  readonly name?: string;
  /**
   * Manifest written alongside the bytes.  Defaults to the message type's
   * fully-qualified name; set `''` to write no manifest at all.
   */
  readonly manifest?: string;
  /**
   * Convert the decoded message to a plain object via `toObject` instead
   * of returning `protobufjs`'s `Message` instance.  Default `true`, and
   * a no-op for types that expose no `toObject` (generated static code).
   *
   * Persisted payloads want the plain object: a `Message` carries a
   * prototype nothing downstream preserves, unset fields are absent
   * rather than defaulted, and 64-bit fields arrive as `Long` objects
   * that would be stored as `{low, high, unsigned}`.  The conversion asks
   * for `defaults: true` and long-as-string so what the domain handler
   * sees is what a re-encode would write back.
   */
  readonly plainObjects?: boolean;
};

/**
 * Fluent builder for {@link ProtobufSerializerOptionsType}:
 *
 *     const protobufOptions = ProtobufSerializerOptions.create<Order>()
 *       .withMessageType(messageType)
 *       .withId(101);
 *     const serializer = new ProtobufSerializer(protobufOptions);
 */
export class ProtobufSerializerOptionsBuilder<T = unknown>
  extends OptionsBuilder<ProtobufSerializerOptionsType<T>> {
  /** Start a fresh builder. */
  static create<T = unknown>(): ProtobufSerializerOptionsBuilder<T> {
    return new ProtobufSerializerOptionsBuilder<T>();
  }

  /** The compiled Protobuf message type that does the encoding. */
  withMessageType(messageType: ProtobufMessageType<T>): this {
    return this.set('messageType', messageType);
  }

  /** Wire identifier embedded in every frame.  Must be >= 100. */
  withId(id: number): this {
    return this.set('id', id);
  }

  /** Diagnostic name shown in error messages. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** Manifest written alongside the bytes; `''` writes none. */
  withManifest(manifest: string): this {
    return this.set('manifest', manifest);
  }

  /** Decode to a plain object rather than a `Message` instance. */
  withPlainObjects(plainObjects: boolean): this {
    return this.set('plainObjects', plainObjects);
  }
}

/**
 * Validates resolved {@link ProtobufSerializerOptionsType} settings — same
 * reasoning as the Avro validator: `id` is a wire contract that outlives
 * the process, so it is rejected at construction rather than on replay.
 */
export class ProtobufSerializerOptionsValidator<T = unknown>
  extends OptionsValidator<ProtobufSerializerOptionsType<T>> {
  constructor() {
    super('ProtobufSerializerOptions');
  }

  protected rules(s: Partial<ProtobufSerializerOptionsType<T>>): void {
    if (s.messageType === undefined) this.fail('messageType', 'is required');
    if (s.id === undefined) this.fail('id', 'is required');
    this.positiveInt('id');
    if (s.id !== undefined && s.id < RESERVED_SERIALIZER_IDS_BELOW) {
      this.fail('id', `must be >= ${RESERVED_SERIALIZER_IDS_BELOW} (1-99 are reserved for built-in serializers)`, s.id);
    }
    this.nonEmptyString('name');
  }
}

/**
 * Accepted input for a {@link ProtobufSerializer}: the fluent
 * {@link ProtobufSerializerOptionsBuilder} OR a plain
 * {@link ProtobufSerializerOptionsType} object.
 */
export type ProtobufSerializerOptions<T = unknown> =
  ProtobufSerializerOptionsBuilder<T> | Partial<ProtobufSerializerOptionsType<T>>;
/** Value alias so `ProtobufSerializerOptions.create()` resolves to the builder. */
export const ProtobufSerializerOptions = ProtobufSerializerOptionsBuilder;
