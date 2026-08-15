import { SerializationError, type Serializer } from '../serialization/index.js';

/**
 * Decoded shape of an `application/x-www-form-urlencoded` body.
 *
 * A repeated field (`tag=a&tag=b`, the wire form a multi-select produces)
 * becomes an array, a single one stays a string — the same widening
 * `HttpRequest.query` already uses, so a value read from the query string
 * and the same value read from a form body have one shape, not two.
 */
export type FormFields = Record<string, string | string[]>;

/**
 * Serializer for HTML form bodies (`application/x-www-form-urlencoded`).
 *
 * It lives in `src/http/` rather than beside `JsonSerializer` /
 * `CborSerializer` because it is not a wire codec: form encoding carries no
 * types (every value is a string), cannot express nesting, and is only ever
 * produced by a browser submitting a `<form>`.  Using it for cluster
 * messages or a journal would be lossy in ways JSON and CBOR are not, so it
 * is deliberately NOT registered with `SerializationExtension` and its `id`
 * never reaches a frame — it exists only so `entity()` can dispatch on
 * Content-Type through the one `Serializer` interface (#669).
 *
 * `URLSearchParams` does the parsing, which keeps this dependency-free and
 * identical on Bun, Node and Deno.  Note that `+` decodes to a space, per
 * the HTML form serialization rules that define this media type.
 */
export class FormUrlEncodedSerializer implements Serializer<FormFields> {
  /**
   * 3 — inside the 1..99 range reserved for built-ins, so no user serializer
   * can collide with it.  Claimed rather than left unset because
   * {@link Serializer} requires an id; nothing ever writes it to the wire.
   */
  readonly id = 3;
  readonly name = 'form-urlencoded';
  readonly includesManifest = false;

  manifest(_obj: FormFields): string { return ''; }

  /**
   * Encode a flat record back into `a=1&b=2`.
   *
   * Present so the type is a real, round-trippable `Serializer` rather than
   * a half-implemented one.  Anything the format cannot express — a nested
   * object, a number, `null` — is a `SerializationError` instead of the
   * `'[object Object]'` a plain `URLSearchParams` append would have written.
   */
  toBinary(obj: FormFields): Uint8Array {
    const params = new URLSearchParams();
    for (const [field, value] of Object.entries(obj)) {
      for (const single of Array.isArray(value) ? value : [value]) {
        if (typeof single !== 'string') {
          throw new SerializationError(
            `FormUrlEncodedSerializer: field '${field}' is ${typeof single}, but form encoding carries strings only`,
          );
        }
        params.append(field, single);
      }
    }
    return new TextEncoder().encode(params.toString());
  }

  /**
   * Field names come straight off the wire, so the write goes through
   * `Object.defineProperty` rather than `fields[field] = …`: plain assignment
   * is `[[Set]]`, which hands a field literally named `__proto__` to the
   * inherited setter instead of creating an own property.  A repeated
   * `__proto__=a&__proto__=b` decodes to an *array*, and an array is an
   * object, so that setter would re-parent the decoded record — the same
   * hazard `cloneTree` and `deepMerge` guard against in `src/config/`.
   * Defining the property keeps the field as data and the prototype intact.
   */
  fromBinary(bytes: Uint8Array, _manifest: string): FormFields {
    const params = new URLSearchParams(new TextDecoder().decode(bytes));
    const fields: FormFields = {};
    for (const field of new Set(params.keys())) {
      const values = params.getAll(field);
      Object.defineProperty(fields, field, {
        value: values.length === 1 ? values[0]! : values,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return fields;
  }
}
