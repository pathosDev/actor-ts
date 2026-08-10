import { ownedBytes } from './ByteViews.js';
import { SerializationError, type Serializer } from './Serializer.js';
import { ProtobufSerializerOptionsValidator } from './ProtobufSerializerOptions.js';
import type {
  ProtobufConversionOptions,
  ProtobufMessageType,
  ProtobufSerializerOptions,
  ProtobufSerializerOptionsType,
} from './ProtobufSerializerOptions.js';

/**
 * `toObject` settings used when decoding to plain objects.  `defaults`
 * fills unset fields so a decoded value has the same shape whatever the
 * writer omitted, and long-as-string keeps 64-bit fields storable — a
 * `Long` instance would otherwise be persisted as `{low, high, unsigned}`
 * and come back as an object nothing downstream understands.
 */
const PLAIN_OBJECT_CONVERSION: ProtobufConversionOptions = { defaults: true, longs: String };

/**
 * Protobuf `Serializer` — schema-driven binary with the wire-level
 * forward compatibility Protobuf is chosen for (unknown fields are
 * skipped rather than fatal).
 *
 * The schema library stays the user's: pass a compiled message type from
 * `protobufjs` reflection, a JSON descriptor, or generated static code.
 * This class owns what is easy to get wrong by hand — `protobufjs`'s
 * `Writer.finish()` returns a view into a shared pool, so the bytes are
 * detached before they can be handed to a journal; `encode` performs no
 * validation, so `verify` runs first when the type offers it; and a
 * decoded `Message` is converted to a plain object, which is what a
 * persisted payload actually needs.
 *
 *     import protobuf from 'protobufjs';
 *
 *     const root = protobuf.parse(protoSource).root;
 *     const protobufOptions = ProtobufSerializerOptions.create<Order>()
 *       .withMessageType(root.lookupType('Order'))
 *       .withId(101);
 *     const serializer = new ProtobufSerializer(protobufOptions);
 *
 * Reaches stored rows through a store's `withSerializer(...)` (one format
 * for the whole store) or, per `(manifest, version)`, through
 * `serializerCodec(serializer)` and the `SchemaRegistry`.
 *
 * Stateless and safe to share: every method reads only the message type.
 */
export class ProtobufSerializer<T = unknown> implements Serializer<T> {
  readonly id: number;
  readonly name: string;
  readonly includesManifest: boolean;

  private readonly messageType: ProtobufMessageType<T>;
  private readonly typeManifest: string;
  private readonly plainObjects: boolean;

  constructor(options: ProtobufSerializerOptions<T>) {
    const settings: Partial<ProtobufSerializerOptionsType<T>> = {
      name: 'protobuf',
      plainObjects: true,
      ...(options as Partial<ProtobufSerializerOptionsType<T>>),
    };
    new ProtobufSerializerOptionsValidator<T>().validate(settings);
    this.messageType = settings.messageType!;
    this.id = settings.id!;
    this.name = settings.name!;
    this.plainObjects = settings.plainObjects!;
    this.typeManifest = settings.manifest ?? this.messageType.fullName ?? '';
    this.includesManifest = this.typeManifest !== '';
  }

  manifest(_obj: T): string { return this.typeManifest; }

  toBinary(obj: T): Uint8Array {
    const violation = this.messageType.verify?.(obj);
    if (typeof violation === 'string') {
      throw new SerializationError(`${this.describe()} value does not match the schema: ${violation}`);
    }
    try {
      return ownedBytes(this.messageType.encode(obj).finish());
    } catch (e) {
      throw new SerializationError(`${this.describe()} encode failed: ${reason(e)}`);
    }
  }

  fromBinary(bytes: Uint8Array, manifest: string): T {
    this.assertManifest(manifest);
    let decoded: unknown;
    try {
      decoded = this.messageType.decode(bytes);
    } catch (e) {
      throw new SerializationError(`${this.describe()} decode failed: ${reason(e)}`);
    }
    const toObject = this.messageType.toObject;
    if (!this.plainObjects || toObject === undefined) return decoded as T;
    return toObject.call(this.messageType, decoded, PLAIN_OBJECT_CONVERSION) as T;
  }

  /**
   * Protobuf's wire format carries field numbers but not the message
   * name, so bytes from a different message often decode without error
   * into a wrong-but-plausible value.  The manifest is the only thing
   * that catches that, hence the check before decoding.  An empty
   * incoming manifest means the writer used a manifest-less serializer
   * and is let through.
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
