/**
 * #967 — `entity()` decodes a request body as plain JSON unless the route opts
 * in to specific `JsonTree` tags.
 *
 * Before this, every JSON body went through the full tag walker, so a client
 * chose the runtime class of any value the handler received: a `RegExp` it
 * wrote, a `bigint` that passes `amount > 0` and throws out of the response
 * encoder, an `undefined` no `JSON.parse` can produce.  These tests post each
 * tag through a live route and look at what the handler actually holds.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { EntityOptions } from '../../../src/http/EntityOptions.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { entity } from '../../../src/http/Marshalling.js';
import { completeJson, post } from '../../../src/http/Route.js';
import type { Route } from '../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { JSON_TREE_TAG_NAMES } from '../../../src/serialization/Constants.js';
import { encodeJsonTree } from '../../../src/serialization/JsonTree.js';

const bindings: ServerBinding[] = [];
const systems: ActorSystem[] = [];

afterEach(async () => {
  while (bindings.length) await bindings.shift()!.unbind();
  while (systems.length) await systems.shift()!.terminate();
});

async function startServer(routes: Route): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('entity-tags', systemOptions);
  systems.push(system);
  const backend = new FastifyBackend({ logger: false });
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
  bindings.push(binding);
  return `http://${binding.host}:${binding.port}`;
}

/** What the handler holds, described in plain JSON so the response encoder cannot blur it. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object' || value === null) return typeof value;
  return Object.getPrototypeOf(value) === Object.prototype ? 'plain-object' : value.constructor.name;
}

/** One hostile body per tag, as the real encoder writes it — so each is a well-formed instruction. */
const HOSTILE_BODIES: Readonly<Record<string, unknown>> = {
  'date': encodeJsonTree(new Date(0)),
  'bytes': encodeJsonTree(new Uint8Array([1])),
  'map': encodeJsonTree(new Map([['a', 1]])),
  'set': encodeJsonTree(new Set([1])),
  'bidirectional-map': { __bidirectionalmap__: [['a', 1]] },
  'bidirectional-multi-map': { __bidirectionalmultimap__: [['a', [1]]] },
  'bigint': { __bigint__: '1' },
  'number': { __number__: 'nan' },
  'undefined': { __undefined__: true },
  'regexp': { __regexp__: { source: '(a+)+$', flags: 'g' } },
  'url': { __url__: 'file:///etc/passwd' },
  'error': { __error__: { name: 'TypeError', message: 'x' } },
  'typed-array': encodeJsonTree(new Float64Array([1])),
};

describe('entity() — plain JSON by default (#967)', () => {
  test('every tag posted to a live route reaches the handler as plain data', async () => {
    expect(Object.keys(HOSTILE_BODIES).sort()).toEqual([...JSON_TREE_TAG_NAMES].sort());
    const url = await startServer(post((request) => {
      const body = entity<Record<string, unknown>>(request);
      const seen: Record<string, string> = {};
      for (const [name, value] of Object.entries(body)) seen[name] = describeValue(value);
      return completeJson(Status.OK, { seen, keys: Object.keys(body) });
    }));

    const response = await fetch(`${url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(HOSTILE_BODIES),
    });
    expect(response.status).toBe(200);
    const { seen, keys } = await response.json() as { seen: Record<string, string>; keys: string[] };
    expect(keys.sort()).toEqual(Object.keys(HOSTILE_BODIES).sort());
    for (const name of JSON_TREE_TAG_NAMES) expect(seen[name]).toBe('plain-object');
  });

  test('the bigint shape stays an object, so a numeric guard does not pass it', async () => {
    const url = await startServer(post((request) => {
      const body = entity<{ amount: unknown }>(request);
      return completeJson(Status.OK, { passesGuard: (body.amount as number) > 0 });
    }));
    const response = await fetch(`${url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"amount":{"__bigint__":"1"}}',
    });
    expect(await response.json()).toEqual({ passesGuard: false });
  });

  test('a body without a content-type is decoded the same way', () => {
    const request: HttpRequest = {
      method: 'POST', path: '/', headers: {}, query: {}, params: {},
      body: new TextEncoder().encode('{"pattern":{"__regexp__":{"source":"a","flags":""}}}'),
    };
    const body = entity<{ pattern: unknown }>(request);
    expect(body.pattern).toEqual({ __regexp__: { source: 'a', flags: '' } });
  });
});

describe('entity() — per-tag opt-in', () => {
  test('a route that opts in to date gets a Date, and nothing else it did not ask for', async () => {
    const entityOptions = EntityOptions.create().withTags(['date']);
    const url = await startServer(post((request) => {
      const body = entity<{ when: unknown }>(request, entityOptions);
      return completeJson(Status.OK, { when: describeValue(body.when) });
    }));
    const response = await fetch(`${url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ when: HOSTILE_BODIES['date'] }),
    });
    expect(await response.json()).toEqual({ when: 'Date' });
  });

  test('a tag outside the opt-in is a 400 naming it, not a value of another class', async () => {
    const entityOptions = EntityOptions.create().withTags(['date']);
    const url = await startServer(post((request) => {
      entity(request, entityOptions);
      return completeJson(Status.OK, { reached: true });
    }));
    const response = await fetch(`${url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: HOSTILE_BODIES['regexp'] }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("'regexp'");
  });

  test('a plain options object works as well as the builder', () => {
    const request: HttpRequest = {
      method: 'POST', path: '/', headers: { 'content-type': 'application/json' }, query: {}, params: {},
      body: new TextEncoder().encode('{"n":{"__bigint__":"5"}}'),
    };
    expect(entity<{ n: unknown }>(request, { tags: ['bigint'] }).n).toBe(5n);
  });

  test('an unknown tag name is refused when the options are validated', () => {
    const request: HttpRequest = {
      method: 'POST', path: '/', headers: { 'content-type': 'application/json' }, query: {}, params: {},
      body: new TextEncoder().encode('{}'),
    };
    let thrown: unknown;
    try {
      entity(request, { tags: ['regex' as never] });
    } catch (e) { thrown = e; }
    // A route's own typo is a server bug, not the client's 400.
    expect(thrown).not.toBeInstanceOf(HttpError);
    expect(String(thrown)).toContain('regex');
  });
});
