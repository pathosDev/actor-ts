/**
 * Request attributes — the slot a middleware uses to hand a handler what it
 * established about a request: the claims a token verifier checked, the
 * session a cookie resolved to (#810, #1553).
 *
 * The obvious carrier, a request header, is the wrong one for anything a
 * handler trusts.  `requestId()` and `csrfProtection()` forward their values
 * that way, which is fine for a correlation id and a token the handler only
 * echoes, but a header is client input: on a route the middleware does not
 * wrap, the same header arrives verbatim from the client, and the handler
 * cannot tell the two apart.  An attribute lives on `HttpRequest.attributes`,
 * which no backend ever sets, so only server code inside the chain can put
 * one there.
 *
 * Keys are typed and addressed by name.  The name is the identity — two
 * `RequestAttributeKey.of('x')` calls address the same slot — which keeps the
 * record a plain, spreadable object; the framework's own keys are named under
 * `actor-ts.`, so an application's names should stay out of that prefix.
 *
 * HTTP routes only.  A middleware around a `websocket()` route runs inside
 * the upgrade check, and the backend hands the connection the upgrade request
 * it adapted itself, so an attribute attached at the handshake does not reach
 * the socket.  The middleware still gates the upgrade.
 */
import type { HttpRequest } from './Types.js';

/**
 * A typed name for one request attribute.
 *
 *     const TENANT = RequestAttributeKey.of<string>('my-app.tenant');
 *     const enriched = withAttribute(request, TENANT, 'acme');
 *     attribute(enriched, TENANT); // 'acme', typed string
 */
export class RequestAttributeKey<T> {
  /**
   * Ties the key to the type of the value it addresses.  Type-level only —
   * never assigned, emitted as nothing.  A function type rather than a plain
   * `T` so the key is invariant in `T`: a key for `'a' | 'b'` must not be
   * usable where a key for `string` is expected, or `withAttribute` could
   * store a `string` that `attribute` then reports as `'a' | 'b'`.
   */
  declare private readonly valueType: (value: T) => T;

  private constructor(
    /** The name the value is stored under in `HttpRequest.attributes`. */
    readonly name: string,
  ) {}

  /** A key for values of type `T`, stored under `name`. */
  static of<T>(name: string): RequestAttributeKey<T> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('RequestAttributeKey: the name must be a non-empty string');
    }
    return new RequestAttributeKey<T>(name);
  }
}

/**
 * The value `request` carries under `key`, or `undefined` when nothing was
 * attached under that name.
 *
 * Reads own properties only.  `attributes` is a plain object, so a bare index
 * would answer `Object.prototype.constructor` for a key named `constructor`
 * that nobody attached.
 */
export function attribute<T>(request: HttpRequest, key: RequestAttributeKey<T>): T | undefined {
  const attributes = request.attributes;
  if (attributes === undefined || !Object.hasOwn(attributes, key.name)) return undefined;
  return attributes[key.name] as T;
}

/**
 * A copy of `request` that also carries `value` under `key` — what a
 * middleware passes to `next(...)`.
 *
 * A copy, never a mutation: the request an outer middleware still holds keeps
 * the attributes it had, so a value attached further in cannot leak back out
 * through it.  The new record is frozen for the same reason, and an existing
 * value under the same name is replaced in the copy only.
 */
export function withAttribute<T>(request: HttpRequest, key: RequestAttributeKey<T>, value: T): HttpRequest {
  return {
    ...request,
    attributes: Object.freeze({ ...request.attributes, [key.name]: value }),
  };
}
