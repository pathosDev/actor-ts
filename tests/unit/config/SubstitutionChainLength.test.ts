import { describe, expect, test } from 'bun:test';
import { parseHocon, resolveSubstitutions } from '../../../src/config/HoconParser.js';

/**
 * #1836: a long chain of substitutions — each key naming the next — used to
 * resolve with one level of recursion per link and a linear scan of the open
 * chain per link.  20 000 links overflowed the engine's stack with a
 * `RangeError`, and 5 000 took 1.6 s.  The resolver now walks a chain's
 * dependencies with an explicit stack and finds an open field by a map.
 */

const LINKS = 20_000;

/** `k0 = ${k1}`, `k1 = ${k2}`, …, and the last link is `1`. */
function chain(links: number, render: (index: number) => string, last: string): string {
  const lines: string[] = [];
  for (let index = 0; index < links - 1; index++) lines.push(render(index));
  lines.push(last);
  return lines.join('\n');
}

describe('SubstitutionResolver — long chains (#1836)', () => {
  test('a 20 000-link chain of lone substitutions resolves, every link to the last value', () => {
    const source = chain(LINKS, (index) => `k${index} = \${k${index + 1}}`, `k${LINKS - 1} = 1`);
    const resolved = resolveSubstitutions(parseHocon(source), {});
    expect(resolved['k0']).toBe(1);
    expect(resolved[`k${LINKS / 2}`]).toBe(1);
    expect(Object.keys(resolved)).toHaveLength(LINKS);
  });

  test('a 20 000-link chain through object paths resolves as well', () => {
    const source = chain(LINKS, (index) => `k${index}.v = \${k${index + 1}.v}`, `k${LINKS - 1}.v = done`);
    const resolved = resolveSubstitutions(parseHocon(source), {});
    expect(resolved['k0']).toEqual({ v: 'done' });
  });

  test('a 20 000-link chain through the fields of objects resolves, nesting the value as deep', () => {
    // `k0 { v = ${k1} }`: each object's own field names the next object.
    const source = chain(LINKS, (index) => `k${index} { v = \${k${index + 1}} }`, `k${LINKS - 1} = 1`);
    const resolved = resolveSubstitutions(parseHocon(source), {});
    let value: unknown = resolved['k0'];
    let depth = 0;
    while (typeof value === 'object' && value !== null) {
      value = (value as Record<string, unknown>)['v'];
      depth++;
    }
    expect(depth).toBe(LINKS - 1);
    expect(value).toBe(1);
  });

  test('a 20 000-link chain through list elements resolves, nesting the lists as deep', () => {
    const source = chain(LINKS, (index) => `k${index} = [\${k${index + 1}}]`, `k${LINKS - 1} = 1`);
    const resolved = resolveSubstitutions(parseHocon(source), {});
    let value: unknown = resolved['k0'];
    let depth = 0;
    while (Array.isArray(value)) {
      value = value[0];
      depth++;
    }
    expect(depth).toBe(LINKS - 1);
    expect(value).toBe(1);
  });

  test('a 20 000-link chain whose lookups pass through a substituted prefix resolves', () => {
    // `b{i}.v` names `a{i+1}.v`, and `a{i+1}` is itself a substitution, so the
    // lookup resolves the field at the prefix, `a{i+1}`, before descending.
    const lines: string[] = [];
    for (let index = 0; index < LINKS - 1; index++) {
      lines.push(`a${index} = \${b${index}}`, `b${index} { v = \${a${index + 1}.v} }`);
    }
    lines.push(`a${LINKS - 1} { v = end }`);
    const resolved = resolveSubstitutions(parseHocon(lines.join('\n')), {});
    expect(resolved['a0']).toEqual({ v: 'end' });
  });

  test('a list still reports its first failing element, not a later one resolved ahead of it', () => {
    expect(() => resolveSubstitutions(parseHocon('a = [${FIRST_MISSING}, ${b}]\nb = ${SECOND_MISSING}'), {}))
      .toThrow('Unresolved substitution: ${FIRST_MISSING}');
  });

  test('a 20 000-link chain written in reverse order resolves the same way', () => {
    const lines = [`k${LINKS - 1} = 7`];
    for (let index = LINKS - 2; index >= 0; index--) lines.push(`k${index} = \${k${index + 1}}`);
    const resolved = resolveSubstitutions(parseHocon(lines.join('\n')), {});
    expect(resolved['k0']).toBe(7);
  });

  test('a 20 000-link cycle is refused with a cycle error naming its keys, not a RangeError', () => {
    const source = chain(LINKS, (index) => `k${index} = \${k${index + 1}}`, `k${LINKS - 1} = \${k0}`);
    let caught: unknown;
    try {
      resolveSubstitutions(parseHocon(source), {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RangeError);
    const message = (caught as Error).message;
    expect(message.startsWith('Substitution cycle: k0 -> k1 -> k2 -> ')).toBe(true);
    expect(message.endsWith(` -> k${LINKS - 1} -> k0`)).toBe(true);
  });

  test('the cost is linear: 20 000 links resolve well inside the time a quadratic scan needs', () => {
    // A linear scan of the open chain per link costs 2·10⁸ key comparisons at
    // this length — tens of seconds.  Linear resolution takes well under one.
    const source = chain(LINKS, (index) => `k${index} = \${k${index + 1}}`, `k${LINKS - 1} = 1`);
    const tree = parseHocon(source);
    const started = performance.now();
    resolveSubstitutions(tree, {});
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('a concatenation still reports its first failing piece, not a later one resolved ahead of it', () => {
    // The piece the tree cannot answer comes first, so its error is the one
    // to report even though the field after it fails as well.
    expect(() => resolveSubstitutions(parseHocon('a = "x"${FIRST_MISSING}${b}\nb = ${SECOND_MISSING}'), {}))
      .toThrow('Unresolved substitution: ${FIRST_MISSING}');
  });

  test('the unresolved end of a long chain is still refused with the key it names', () => {
    const source = chain(LINKS, (index) => `k${index} = \${k${index + 1}}`, `k${LINKS - 1} = \${MISSING_AT_THE_END}`);
    expect(() => resolveSubstitutions(parseHocon(source), {})).toThrow('Unresolved substitution: ${MISSING_AT_THE_END}');
  });
});
