import { SerializationError } from '../../serialization/Serializer.js';
import type { SerializedValue, Serializer } from '../../serialization/Serializer.js';

/**
 * Pluggable wire codec for journal payloads (#6).
 *
 * The persistence layer serialises everything as tagged JSON — the
 * `JsonTree` format applied by `storage/PayloadCodec.ts`, in which
 * `Date`/`Map`/`Set`/`bigint`/`Uint8Array` round-trip (#888) — that's
 * the baseline contract.  But user code often wants stronger guarantees
 * about the *shape* of the JSON it stores: every event matches a
 * known schema, every snapshot decodes cleanly, malformed wire
 * data is rejected loud and early instead of crashing somewhere in
 * `onEvent`.  A `Codec<T>` is the validate-on-encode/decode hook
 * that gets you that.
 *
 * Two shipped impls:
 *
 *   - `jsonCodec<T>()` — pass-through.  No validation.  Same as the
 *     framework's default behaviour.  Use when you don't have or
 *     don't need schema validation.
 *   - `zodCodec<T>(schema)` — validates against any object exposing
 *     a `parse(unknown): T` method.  Zod schemas, `valibot` schemas
 *     with a `parse` adapter, and any hand-rolled validator all
 *     fit.  We don't import `zod` directly — the user brings their
 *     own dependency and passes the schema in.
 *
 * Binary formats (Avro, Protobuf, MessagePack) are NOT built by
 * hand here: they are `Serializer` implementations under
 * `src/serialization/`, and `serializerCodec` below adapts one into
 * a `Codec<T>` so the SchemaRegistry can hold a different wire
 * format per `(manifest, version)` (#73).
 */

/**
 * A bidirectional value-transform with validation on both sides.
 * `encode` is called when the actor is about to persist; `decode`
 * is called after a successful journal read but **before** the
 * domain handler sees the payload.  Errors thrown from either
 * surface as `PersistError` / `MigrationError` at the actor layer.
 */
export interface Codec<T> {
  /**
   * Validate / serialise a domain value for the wire.  Returning
   * the input unchanged is fine — the codec's job is to throw on
   * invalid input, not necessarily to reshape the payload.
   */
  encode(value: T): unknown;
  /** Inverse of `encode`. */
  decode(wire: unknown): T;
  /** Diagnostic name shown in error messages. */
  readonly name?: string;
}

/**
 * Pass-through codec — no validation, identity transform.  Same
 * shape as the framework's default behaviour when no codec is
 * supplied.  Useful as a default in generic helpers, and as the
 * baseline you compose richer codecs on top of.
 */
export function jsonCodec<T>(): Codec<T> {
  return {
    name: 'json',
    encode: (v: T) => v as unknown,
    decode: (w: unknown) => w as T,
  };
}

/**
 * Minimal interface a schema must satisfy to plug into `zodCodec`.
 * Zod's `ZodSchema<T>` matches it; valibot exposes a compatible
 * `parse` via its standard helpers; any hand-rolled validator
 * with a single `parse` method that throws on invalid input works.
 */
export interface ParserLike<T> {
  /** Validate `input` and return a typed value.  Throws on invalid. */
  parse(input: unknown): T;
}

/**
 * Codec that validates with any `parse`-style schema (Zod, valibot,
 * hand-rolled).  We don't import `zod` directly — the user's
 * project owns the dependency and passes the schema in.
 *
 *   import { z } from 'zod';
 *
 *   const Deposited = z.object({
 *     kind: z.literal('deposited'),
 *     amount: z.number().int().nonnegative(),
 *     currency: z.enum(['USD', 'EUR']),
 *   });
 *
 *   const adapter = validatedEventAdapter(
 *     defaultsAdapter<DepositedV2>({ ... }),
 *     zodCodec(Deposited),
 *   );
 *
 * Validates:
 *   - On `toJournal`: a programmer-bug malformed event is caught
 *     at write time, not after it's already on disk.
 *   - On `fromJournal`: a corrupted / hand-edited journal record
 *     fails the deserialise instead of silently producing garbage.
 *
 * `zodCodec` does NOT participate in **schema-evolution** by
 * itself — pair it with `defaultsAdapter`, `migratingAdapter`, or
 * the SchemaRegistry to cover version differences.  This codec
 * validates one specific shape; it has no idea what older or newer
 * versions look like.
 */
export function zodCodec<T>(schema: ParserLike<T>, name = 'zod'): Codec<T> {
  return {
    name,
    encode: (value: T) => schema.parse(value),
    decode: (wire: unknown) => schema.parse(wire),
  };
}

/**
 * Compose two codecs serially: the first transforms domain → mid,
 * the second transforms mid → wire.  Decoding runs in reverse.
 * Handy when you want validation on top of a structural transform
 * (e.g. `composeCodecs(camelCaseCodec, zodCodec(schema))`).
 */
export function composeCodecs<A, B>(
  first: Codec<A>,
  second: Codec<B>,
  name?: string,
): Codec<A> {
  return {
    name: name ?? `${first.name ?? 'a'}>>${second.name ?? 'b'}`,
    encode: (a: A): unknown => second.encode(first.encode(a) as B),
    decode: (c: unknown): A => first.decode(second.decode(c)),
  };
}

/**
 * Adapt a byte-native `Serializer` into a `Codec<T>` (#73), so a binary
 * format reaches the migration layer at the granularity the migration
 * layer actually works at.
 *
 * **Why this exists next to `withSerializer`.**  A store's `serializer`
 * option applies to the whole store — one format for every payload it
 * writes.  The SchemaRegistry holds a codec per `(manifest, version)`,
 * which is the only place a v1 written in Avro and a v2 written in
 * Protobuf can coexist in one stream.  Wrapping the serializer keeps a
 * single implementation of each format instead of one Serializer plus a
 * near-identical Codec:
 *
 *     registry.register('BankAccount.Deposited', 1, {
 *       codec: serializerCodec(avroSerializer),
 *     });
 *     registry.register('BankAccount.Deposited', 2, {
 *       codec: serializerCodec(protobufSerializer),
 *       upcastFromPrev: (v1: DepositedV1): DepositedV2 => ({ ...v1, currency: 'USD' }),
 *     });
 *
 * **Wire shape.**  `encode` returns a `SerializedValue` — `{serializerId,
 * manifest, bytes}` — and stops there.  The bytes are NOT base64'd here:
 * the journal's `PayloadCodec` already round-trips a `Uint8Array` through
 * the tagged-JSON `__bytes__` form, so encoding them again would cost a
 * second base64 expansion for nothing.  `serializerId` travels with the
 * payload so a row written by one serializer and read back by another
 * fails with a named error instead of decoding into garbage — Avro in
 * particular carries no field tags, so wrong bytes decode "successfully".
 */
export function serializerCodec<T>(serializer: Serializer<T>, name?: string): Codec<T> {
  const codecName = name ?? `serializer:${serializer.name}`;
  return {
    name: codecName,
    encode: (value: T): unknown => ({
      serializerId: serializer.id,
      manifest: serializer.manifest(value),
      bytes: serializer.toBinary(value),
    } satisfies SerializedValue),
    decode: (wire: unknown): T => {
      const frame = serializedValue(wire, codecName);
      if (frame.serializerId !== serializer.id) {
        throw new SerializationError(
          `${codecName}: payload was written by serializer id ${frame.serializerId}`
          + `${frame.manifest ? ` (manifest '${frame.manifest}')` : ''}, but this codec holds`
          + ` '${serializer.name}' (id ${serializer.id})`,
        );
      }
      return serializer.fromBinary(frame.bytes, frame.manifest);
    },
  };
}

/**
 * Read back what `serializerCodec.encode` wrote.  Anything else is a
 * payload this codec never produced — a plain-JSON row from before the
 * format was switched, most likely — and saying so beats a `TypeError`
 * from inside the serializer.
 */
function serializedValue(wire: unknown, codecName: string): SerializedValue {
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
    throw new SerializationError(`${codecName}: expected a serialized payload object, got ${typeof wire}`);
  }
  const candidate = wire as Record<string, unknown>;
  if (typeof candidate['serializerId'] !== 'number' || !(candidate['bytes'] instanceof Uint8Array)) {
    throw new SerializationError(
      `${codecName}: payload is not a serialized frame — expected {serializerId, manifest, bytes}`,
    );
  }
  return {
    serializerId: candidate['serializerId'],
    manifest: typeof candidate['manifest'] === 'string' ? candidate['manifest'] : '',
    bytes: candidate['bytes'],
  };
}
