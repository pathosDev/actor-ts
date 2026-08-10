import { asNodeBuffer, ownedBytes } from './ByteViews.js';
import { SerializationError, type Serializer } from './Serializer.js';
import { AvroSerializerOptionsValidator } from './AvroSerializerOptions.js';
import type {
  AvroSerializerOptions,
  AvroSerializerOptionsType,
  AvroType,
} from './AvroSerializerOptions.js';

/**
 * Avro `Serializer` — compact, schema-driven binary for a single type.
 *
 * The schema library stays the user's: pass a compiled `avsc` type (or
 * anything with the same `toBuffer`/`fromBuffer` pair) and this class owns
 * the parts that are easy to get wrong when wiring one up by hand —
 * the `Buffer` coercion `avsc` needs on the read path (a plain
 * `Uint8Array`, which is what base64 framing yields, throws deep inside
 * the decoder), byte ownership, the manifest, and errors that name the
 * serializer instead of surfacing a library-internal message.
 *
 *     import avsc from 'avsc';
 *
 *     const avroType = avsc.Type.forSchema({
 *       name: 'Deposited',
 *       type: 'record',
 *       fields: [{ name: 'amount', type: 'int' }],
 *     });
 *     const avroOptions = AvroSerializerOptions.create<Deposited>()
 *       .withAvroType(avroType)
 *       .withId(100);
 *     const serializer = new AvroSerializer(avroOptions);
 *
 * Reaches stored rows through a store's `withSerializer(...)` (one format
 * for the whole store) or, per `(manifest, version)`, through
 * `serializerCodec(serializer)` and the `SchemaRegistry`.
 *
 * Stateless and safe to share: every method reads only the compiled type.
 */
export class AvroSerializer<T = unknown> implements Serializer<T> {
  readonly id: number;
  readonly name: string;
  readonly includesManifest: boolean;

  private readonly avroType: AvroType<T>;
  private readonly typeManifest: string;

  constructor(options: AvroSerializerOptions<T>) {
    const settings: Partial<AvroSerializerOptionsType<T>> = {
      name: 'avro',
      ...(options as Partial<AvroSerializerOptionsType<T>>),
    };
    new AvroSerializerOptionsValidator<T>().validate(settings);
    this.avroType = settings.avroType!;
    this.id = settings.id!;
    this.name = settings.name!;
    this.typeManifest = settings.manifest ?? this.avroType.name ?? '';
    this.includesManifest = this.typeManifest !== '';
  }

  manifest(_obj: T): string { return this.typeManifest; }

  toBinary(obj: T): Uint8Array {
    try {
      return ownedBytes(this.avroType.toBuffer(obj));
    } catch (e) {
      throw new SerializationError(`${this.describe()} encode failed: ${reason(e)}`);
    }
  }

  fromBinary(bytes: Uint8Array, manifest: string): T {
    this.assertManifest(manifest);
    try {
      return this.avroType.fromBuffer(asNodeBuffer(bytes));
    } catch (e) {
      throw new SerializationError(`${this.describe()} decode failed: ${reason(e)}`);
    }
  }

  /**
   * A frame written under a different manifest was produced by a
   * different schema, so decoding it here would either throw somewhere
   * inside `avsc` or — worse, since Avro carries no field tags — succeed
   * and hand back plausible nonsense.  An empty incoming manifest means
   * the writer used a manifest-less serializer and is let through.
   */
  private assertManifest(manifest: string): void {
    if (!this.includesManifest || manifest === '' || manifest === this.typeManifest) return;
    throw new SerializationError(
      `${this.describe()} cannot decode a payload written with manifest '${manifest}'`,
    );
  }

  private describe(): string {
    return this.includesManifest
      ? `${this.name} (id ${this.id}, manifest '${this.typeManifest}'):`
      : `${this.name} (id ${this.id}):`;
  }
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
