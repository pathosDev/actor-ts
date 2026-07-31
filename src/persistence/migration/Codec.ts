/**
 * Pluggable wire codec for journal payloads (#6).
 *
 * The persistence layer serialises everything as JSON — that's the
 * baseline contract.  But user code often wants stronger guarantees
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
 * Avro / Protobuf wire codecs are out-of-scope for v1.  The hooks
 * here are wide enough that a user can build them on top: `encode`
 * returns the shape that ends up in the JSON envelope, so writing
 * an Avro codec means returning a base64 string; the journal is
 * agnostic.
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
