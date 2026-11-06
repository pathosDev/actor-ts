import { describe, expect, test } from 'bun:test';
import { parseHocon, resolveLayer, type ResolvedLayer } from '../../../src/config/HoconParser.js';

/**
 * `resolveLayer` — resolution of one layer of a configuration (#1785): the
 * environment as ordered sources, the resolved layers beneath as a read-only
 * fallback, and which variables supplied each leaf (#1788), the provenance
 * the config dump withholds by.
 */

/** The variables behind each leaf, as `{ 'dotted.path': ['NAME', …] }`, for readable expectations. */
function variablesOf(layer: ResolvedLayer): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, names] of layer.variablesByPath) {
    out[(JSON.parse(key) as string[]).join('.')] = [...names].sort();
  }
  return out;
}

describe('resolveLayer — the environment as ordered sources (#1785)', () => {
  test('the first source with a value answers', () => {
    const layer = resolveLayer(parseHocon('a = ${A}\nb = ${B}'), {
      environment: [{ A: 'from-process' }, { A: 'from-file', B: 'only-in-file' }],
    });
    expect(layer.tree).toStrictEqual({ a: 'from-process', b: 'only-in-file' });
  });

  test('an empty variable in an earlier source does not hide a later one', () => {
    const layer = resolveLayer(parseHocon('a = ${A}'), { environment: [{ A: '' }, { A: 'from-file' }] });
    expect(layer.tree).toStrictEqual({ a: 'from-file' });
  });

  test('a source answers for the upper-cased spelling of a dotted path', () => {
    const layer = resolveLayer(parseHocon('a = ${db.password}'), { environment: [{}, { DB_PASSWORD: 'pw' }] });
    expect(layer.tree).toStrictEqual({ a: 'pw' });
  });

  test('with no source answering, a required substitution still fails', () => {
    expect(() => resolveLayer(parseHocon('a = ${A}'), { environment: [{}, {}] }))
      .toThrow('Unresolved substitution: ${A}');
  });
});

describe('resolveLayer — the layers beneath as a fallback (#1785)', () => {
  test('a substitution reads a key only the layers beneath define', () => {
    const layer = resolveLayer(parseHocon('my-app.db.url = "postgres://"${my-app.db.host}"/app"'), {
      environment: [{}],
      fallback: { 'my-app': { db: { host: 'localhost' } } },
    });
    expect(layer.tree).toStrictEqual({ 'my-app': { db: { url: 'postgres://localhost/app' } } });
  });

  test('the layer\'s own key wins over the layers beneath', () => {
    const layer = resolveLayer(parseHocon('host = "own"\nurl = ${host}'), {
      environment: [{}],
      fallback: { host: 'below' },
    });
    expect(layer.tree).toStrictEqual({ host: 'own', url: 'own' });
  });

  test('the layers beneath win over the environment', () => {
    const layer = resolveLayer(parseHocon('url = ${host}'), {
      environment: [{ HOST: 'from-environment' }],
      fallback: { host: 'below' },
    });
    expect(layer.tree).toStrictEqual({ url: 'below' });
  });

  test('a field that names itself builds on the layers beneath', () => {
    const layer = resolveLayer(parseHocon('path = ${path}":/extra"'), {
      environment: [{}],
      fallback: { path: '/base' },
    });
    expect(layer.tree).toStrictEqual({ path: '/base:/extra' });
  });

  test('an unset optional override drops out of its layer rather than copying the value beneath', () => {
    // Attribution asks each layer whether it has the path, so the upper layer
    // must not come to hold the lower layer's 2552.
    const layer = resolveLayer(parseHocon('port = ${?PORT}'), { environment: [{}], fallback: { port: 2552 } });
    expect(layer.tree).toStrictEqual({});
  });

  test('the fallback is never merged into the result', () => {
    const layer = resolveLayer(parseHocon('a = 1'), { environment: [{}], fallback: { b: 2 } });
    expect(layer.tree).toStrictEqual({ a: 1 });
  });
});

describe('resolveLayer — which variables supplied each leaf (#1788)', () => {
  test('a value read from a variable is supplied by it', () => {
    const layer = resolveLayer(parseHocon('db.password = ${?DB_PASSWORD}\nplain = 1'), {
      environment: [{ DB_PASSWORD: 'hunter2' }],
    });
    expect(variablesOf(layer)).toStrictEqual({ 'db.password': ['DB_PASSWORD'] });
  });

  test('the spelling that answered is the one recorded', () => {
    const layer = resolveLayer(parseHocon('a = ${db.password}'), { environment: [{ DB_PASSWORD: 'pw' }] });
    expect(variablesOf(layer)).toStrictEqual({ a: ['DB_PASSWORD'] });
  });

  test('a reference to such a key inherits its variables, over any number of hops', () => {
    const layer = resolveLayer(parseHocon('a = ${?SECRET}\nb = ${a}\nc = ${b}'), { environment: [{ SECRET: 's' }] });
    expect(variablesOf(layer)).toStrictEqual({ a: ['SECRET'], b: ['SECRET'], c: ['SECRET'] });
  });

  test('a string built from pieces carries the variables of every piece', () => {
    const layer = resolveLayer(parseHocon('url = "redis://"${USER}":"${PASSWORD}"@host"'), {
      environment: [{ USER: 'app', PASSWORD: 'pw' }],
    });
    expect(variablesOf(layer)).toStrictEqual({ url: ['PASSWORD', 'USER'] });
  });

  test('a list is one leaf, carrying the variables of its elements', () => {
    const layer = resolveLayer(parseHocon('seeds = [ ${?S1}, ${?S2}, "static" ]'), { environment: [{ S1: 'a:1' }] });
    expect(variablesOf(layer)).toStrictEqual({ seeds: ['S1'] });
  });

  test('an object read from a variable has every leaf supplied by it', () => {
    const layer = resolveLayer(parseHocon('creds = ${?CREDS}'), {
      environment: [{ CREDS: '{"user":"u","password":"p"}' }],
    });
    expect(variablesOf(layer)).toStrictEqual({ 'creds.password': ['CREDS'], 'creds.user': ['CREDS'] });
  });

  test('a path into a value read from a variable is supplied by that variable', () => {
    const layer = resolveLayer(parseHocon('a = ${?OBJ}\nb = ${a.k}'), { environment: [{ OBJ: '{"k":5}' }] });
    expect(layer.tree).toStrictEqual({ a: { k: 5 }, b: 5 });
    expect(variablesOf(layer)).toStrictEqual({ 'a.k': ['OBJ'], b: ['OBJ'] });
  });

  test('a value found in the layers beneath brings the variables that supplied it there', () => {
    const layer = resolveLayer(parseHocon('dsn = ${db.password}'), {
      environment: [{}],
      fallback: { db: { password: 'pw' } },
      fallbackVariables: (path) => (path.join('.') === 'db.password' ? ['DB_PASSWORD'] : []),
    });
    expect(variablesOf(layer)).toStrictEqual({ dsn: ['DB_PASSWORD'] });
  });

  test('a value the tree supplies on its own has no entry', () => {
    const layer = resolveLayer(parseHocon('a = 1\nb = ${a}\nc = "x"${a}'), { environment: [{}] });
    expect(variablesOf(layer)).toStrictEqual({});
  });

  test('the fallback of an optional substitution brings its own provenance, or none', () => {
    const fromVariable = resolveLayer(parseHocon('x = ${?B}\nx = ${?A}'), { environment: [{ B: 'b' }] });
    expect(variablesOf(fromVariable)).toStrictEqual({ x: ['B'] });
    const fromLiteral = resolveLayer(parseHocon('x = 1\nx = ${?A}'), { environment: [{}] });
    expect(variablesOf(fromLiteral)).toStrictEqual({});
  });
});
