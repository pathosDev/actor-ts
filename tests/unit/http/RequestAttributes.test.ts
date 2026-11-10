import { describe, expect, test } from 'bun:test';
import { attribute, RequestAttributeKey, withAttribute } from '../../../src/http/RequestAttributes.js';
import { compile, completeText, get, withMiddleware, type CompiledRoute, type Middleware } from '../../../src/http/Route.js';
import { csrfProtection } from '../../../src/http/middleware/Csrf.js';
import { requestId } from '../../../src/http/middleware/RequestId.js';
import { Status, type HttpRequest } from '../../../src/http/Types.js';

const request = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null, ...overrides,
});

type Principal = { readonly subject: string };

const PRINCIPAL = RequestAttributeKey.of<Principal>('test.principal');
const TENANT = RequestAttributeKey.of<string>('test.tenant');

describe('RequestAttributeKey / attribute / withAttribute', () => {
  test('withAttribute returns a new request carrying the value and leaves the original as it was', () => {
    const original = request({ headers: { host: 'app.example' } });
    const enriched = withAttribute(original, PRINCIPAL, { subject: 'u1' });

    expect(attribute(enriched, PRINCIPAL)).toEqual({ subject: 'u1' });
    // A copy, never a mutation: the request an outer middleware still holds
    // must not change under it when an inner one attaches something.
    expect(enriched).not.toBe(original);
    expect(original.attributes).toBeUndefined();
    expect(attribute(original, PRINCIPAL)).toBeUndefined();
    // Everything else is carried over unchanged.
    expect(enriched.headers).toBe(original.headers);
    expect(enriched.method).toBe('GET');
  });

  test('a second attribute keeps the first, and rewriting a key replaces only that key', () => {
    const first = withAttribute(request(), PRINCIPAL, { subject: 'u1' });
    const second = withAttribute(first, TENANT, 'acme');
    const rewritten = withAttribute(second, TENANT, 'globex');

    expect(attribute(second, PRINCIPAL)).toEqual({ subject: 'u1' });
    expect(attribute(second, TENANT)).toBe('acme');
    expect(attribute(rewritten, TENANT)).toBe('globex');
    expect(attribute(rewritten, PRINCIPAL)).toEqual({ subject: 'u1' });
    // The intermediate request still answers with what it held.
    expect(attribute(second, TENANT)).toBe('acme');
    expect(first.attributes).toEqual({ 'test.principal': { subject: 'u1' } });
  });

  test('the attribute record a request carries cannot be changed in place', () => {
    const enriched = withAttribute(request(), TENANT, 'acme');
    expect(Object.isFrozen(enriched.attributes)).toBe(true);
  });

  test('attribute answers only what was attached, never a name inherited from Object.prototype', () => {
    // `attributes` is a plain record, so a bare index would hand back
    // `Object.prototype.constructor` for a key nobody attached.
    const constructorKey = RequestAttributeKey.of<unknown>('constructor');
    const toStringKey = RequestAttributeKey.of<unknown>('toString');

    expect(attribute(request(), constructorKey)).toBeUndefined();
    expect(attribute(withAttribute(request(), TENANT, 'acme'), constructorKey)).toBeUndefined();
    expect(attribute(withAttribute(request(), TENANT, 'acme'), toStringKey)).toBeUndefined();
    // A request built by hand with a record of its own is read the same way.
    expect(attribute(request({ attributes: {} }), toStringKey)).toBeUndefined();
    expect(attribute(request({ attributes: { 'test.tenant': 'initech' } }), TENANT)).toBe('initech');
  });

  test('a key named __proto__ is an ordinary slot, not a prototype write', () => {
    const protoKey = RequestAttributeKey.of<string>('__proto__');
    const enriched = withAttribute(request(), protoKey, 'value');

    expect(attribute(enriched, protoKey)).toBe('value');
    expect(Object.getPrototypeOf(enriched.attributes)).toBe(Object.prototype);
    expect(attribute(enriched, TENANT)).toBeUndefined();
  });

  test('a key carries its name, and an empty name is refused', () => {
    expect(PRINCIPAL.name).toBe('test.principal');
    expect(() => RequestAttributeKey.of<string>('')).toThrow(/non-empty/);
  });

  test('a key is typed by its value, in both directions', () => {
    // Checked by `bun run typecheck:dev`, which compiles this file: an unused
    // `@ts-expect-error` is itself an error there.
    // @ts-expect-error — a number is not a value for a string key
    withAttribute(request(), TENANT, 42);
    const narrow = RequestAttributeKey.of<'a' | 'b'>('test.narrow');
    // @ts-expect-error — a key for 'a' | 'b' must not pass for a key for any string,
    // or withAttribute could store a string that attribute() reports as 'a' | 'b'
    const widened: RequestAttributeKey<string> = narrow;
    expect(widened.name).toBe('test.narrow');
  });

  test('an attribute attached outside requestId() and csrfProtection() reaches the handler through compile()', async () => {
    // The two in-chain middlewares that replace the request — both with
    // `{ ...request, headers }` — must carry the slot through, or claims a
    // verifier attached would be gone by the time the handler runs.
    const attach: Middleware = (incoming, next) => next(withAttribute(incoming, PRINCIPAL, { subject: 'u1' }));
    let seen: HttpRequest | undefined;
    const route = withMiddleware(attach,
      withMiddleware(requestId(),
        withMiddleware(csrfProtection({ secret: 'x'.repeat(32) }),
          get((handled) => {
            seen = handled;
            return completeText(Status.OK, 'ok');
          }))));
    const [endpoint] = compile(route) as CompiledRoute[];

    const response = await endpoint!.handler(request());

    expect(response.status).toBe(Status.OK);
    expect(attribute(seen!, PRINCIPAL)).toEqual({ subject: 'u1' });
    // Both re-wraps really happened on the way in, so the slot survived them
    // rather than a path that skipped them.
    expect(seen!.headers['x-request-id']).toBeTruthy();
    expect(seen!.headers['x-csrf-token']).toBeTruthy();
  });

  test('an attribute attached inside requestId() and csrfProtection() reaches the handler too', async () => {
    const attach: Middleware = (incoming, next) => next(withAttribute(incoming, TENANT, 'acme'));
    let seen: HttpRequest | undefined;
    const route = withMiddleware(requestId(),
      withMiddleware(csrfProtection({ secret: 'x'.repeat(32) }),
        withMiddleware(attach,
          get((handled) => {
            seen = handled;
            return completeText(Status.OK, 'ok');
          }))));
    const [endpoint] = compile(route) as CompiledRoute[];

    await endpoint!.handler(request());

    expect(attribute(seen!, TENANT)).toBe('acme');
    expect(seen!.headers['x-request-id']).toBeTruthy();
  });

  test('a route the attaching middleware does not wrap sees no attribute', async () => {
    // The point of a slot over a header: a client can send any header it
    // likes, but nothing it sends can become an attribute.
    let seen: HttpRequest | undefined;
    const [endpoint] = compile(get((handled) => {
      seen = handled;
      return completeText(Status.OK, 'ok');
    })) as CompiledRoute[];

    await endpoint!.handler(request({ headers: { 'test.principal': '{"subject":"admin"}' } }));

    expect(attribute(seen!, PRINCIPAL)).toBeUndefined();
  });
});
