import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { RESERVED_SERIALIZER_IDS_BELOW } from './Constants.js';

/**
 * The slice of an Avro type object that {@link AvroSerializer} uses.
 *
 * Declared structurally rather than imported from `avsc`, for the same
 * reason `zodCodec` takes a `ParserLike` instead of importing `zod`: the
 * schema library belongs to the user's project, and actor-ts has no
 * business pinning a version of it or shipping a lazy import for
 * something it never calls itself.  `avsc`'s `Type` satisfies this shape
 * as-is:
 *
 *     import avsc from 'avsc';
 *     const avroType = avsc.Type.forSchema({ name: 'Order', type: 'record', fields: [...] });
 *
 * Any other library whose compiled type exposes `toBuffer` / `fromBuffer`
 * fits too.
 */
export interface AvroType<T = unknown> {
  /** Encode a value to Avro binary.  Throws when the value doesn't match the schema. */
  toBuffer(value: T): Uint8Array;
  /** Decode Avro binary back to a value.  Needs a Node `Buffer` in `avsc`'s case. */
  fromBuffer(bytes: Uint8Array): T;
  /** Record name from the schema, used as the default manifest when set. */
  readonly name?: string;
}

/** Plain options-object shape accepted by an {@link AvroSerializer}. */
export type AvroSerializerOptionsType<T = unknown> = {
  /** The compiled Avro type that does the encoding.  Required. */
  readonly avroType: AvroType<T>;
  /**
   * Wire identifier embedded in every frame.  Required, and must be
   * >= 100: 1–99 are reserved for the built-ins (JSON=1, CBOR=2), and a
   * collision there is only noticed when a reader decodes garbage.
   */
  readonly id: number;
  /** Diagnostic name shown in error messages.  Default `'avro'`. */
  readonly name?: string;
  /**
   * Manifest written alongside the bytes.  Defaults to the Avro type's
   * record name, so a decoder can tell a `Deposited` row from a
   * `Withdrawn` one; set `''` to write no manifest at all.
   */
  readonly manifest?: string;
};

/**
 * Fluent builder for {@link AvroSerializerOptionsType}:
 *
 *     const avroOptions = AvroSerializerOptions.create<Deposited>()
 *       .withAvroType(avroType)
 *       .withId(100);
 *     const serializer = new AvroSerializer(avroOptions);
 */
export class AvroSerializerOptionsBuilder<T = unknown>
  extends OptionsBuilder<AvroSerializerOptionsType<T>> {
  /** Start a fresh builder. */
  static create<T = unknown>(): AvroSerializerOptionsBuilder<T> {
    return new AvroSerializerOptionsBuilder<T>();
  }

  /** The compiled Avro type that does the encoding. */
  withAvroType(avroType: AvroType<T>): this {
    return this.set('avroType', avroType);
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
}

/**
 * Validates resolved {@link AvroSerializerOptionsType} settings.  `id` is
 * a wire contract that outlives the process — a bad one is discovered
 * when old rows stop decoding, so it is rejected at construction instead.
 */
export class AvroSerializerOptionsValidator<T = unknown>
  extends OptionsValidator<AvroSerializerOptionsType<T>> {
  constructor() {
    super('AvroSerializerOptions');
  }

  protected rules(s: Partial<AvroSerializerOptionsType<T>>): void {
    if (s.avroType === undefined) this.fail('avroType', 'is required');
    if (s.id === undefined) this.fail('id', 'is required');
    this.positiveInt('id');
    if (s.id !== undefined && s.id < RESERVED_SERIALIZER_IDS_BELOW) {
      this.fail('id', `must be >= ${RESERVED_SERIALIZER_IDS_BELOW} (1-99 are reserved for built-in serializers)`, s.id);
    }
    this.nonEmptyString('name');
  }
}

/**
 * Accepted input for an {@link AvroSerializer}: the fluent
 * {@link AvroSerializerOptionsBuilder} OR a plain
 * {@link AvroSerializerOptionsType} object.
 */
export type AvroSerializerOptions<T = unknown> =
  AvroSerializerOptionsBuilder<T> | Partial<AvroSerializerOptionsType<T>>;
/** Value alias so `AvroSerializerOptions.create()` resolves to the builder. */
export const AvroSerializerOptions = AvroSerializerOptionsBuilder;
