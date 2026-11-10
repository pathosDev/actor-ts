import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { NoopLogger } from '../../../src/Logger.js';

/**
 * The configuration page's "Reading config in code" sample reads back the
 * value it prints (#996).
 *
 * The sample handed `withConfig` its override as one dotted key —
 * `{ 'actor-ts.cluster.gossip-interval': '500ms' }` — and promised `500` from
 * `getDuration('actor-ts.cluster.gossip-interval')`.  It read back `1000`, the
 * reference default.  An object's keys are taken as they are, so a dotted key
 * stays one segment literally named `actor-ts.cluster.gossip-interval`, while a
 * lookup walks the path one segment at a time and never meets it.  HOCON text
 * is the other way round — `a.b = 1` *is* a path — which is exactly what makes
 * the dotted spelling look right in a code sample.  The loader accepts the
 * stray key without a word; that silence is #996's subject, and this test only
 * holds the page to what it demonstrates.
 *
 * The sample is replayed rather than paraphrased: the object literal comes out
 * of the fence, travels the real `withConfig` → `ActorSystem.create` path, and
 * the read-back is compared with the `→` figure the fence prints — and with
 * what the system reads when nothing overrides the key, because a figure equal
 * to the default would let the sample "work" without its override doing
 * anything.
 */

const DOCUMENTATION_ROOT = join(
  import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs',
);

/** The section on each page, found by its heading — the pages are mirrors. */
const SAMPLES = [
  {
    language: 'en',
    page: join(DOCUMENTATION_ROOT, 'reference', 'configuration.mdx'),
    heading: '## Reading config in code',
  },
  {
    language: 'de',
    page: join(DOCUMENTATION_ROOT, 'de', 'reference', 'configuration.mdx'),
    heading: '## Config im Code lesen',
  },
] as const;

/** The first `ts` fence of the `## ` section headed exactly `heading`. */
function sampleUnder(page: string, heading: string): string {
  const lines = readFileSync(page, 'utf8').split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `${heading} is missing from ${page}`).toBeGreaterThan(-1);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const section = lines.slice(start + 1, next === -1 ? undefined : next);
  const open = section.findIndex((line) => /^```ts\b/.test(line));
  expect(open, `${heading} has no ts fence`).toBeGreaterThan(-1);
  const close = section.findIndex((line, index) => index > open && line.startsWith('```'));
  return section.slice(open + 1, close).join('\n');
}

/**
 * A line comment, a block comment, or a string in either quote — the spans
 * {@link valueOfLiteral} must not rewrite inside, captured so that `split`
 * keeps them.  Strings come after comments in the alternation and still win
 * where they start first, because a match is taken at the leftmost position.
 */
const LITERAL_TOKENS = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|'[^'\\\n]*'|"[^"\\\n]*")/;

/**
 * The object literal the sample hands `withConfig`, as a value — read, never
 * run.
 *
 * The literal is JSON plus the liberties a code sample takes: single-quoted
 * strings, bare identifier keys, trailing commas and comments.  Normalising
 * exactly those is enough, and anything richer fails `JSON.parse` loudly.
 * That is the right outcome: a sample that outgrows this reader has changed
 * shape, and the test has to be re-read rather than pass on a guess.
 */
function valueOfLiteral(source: string): ConfigObject {
  const json = source
    .split(LITERAL_TOKENS)
    .map((part, index) => {
      if (index % 2 === 0) return part;
      if (part.startsWith('/')) return '';
      return JSON.stringify(part.slice(1, -1));
    })
    .join('')
    .replace(
      /([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g,
      (_key, before: string, name: string, after: string) => `${before}"${name}"${after}`,
    )
    .replace(/,(\s*[}\]])/g, (_comma, closing: string) => closing);
  const value: unknown = JSON.parse(json);
  expect(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `withConfig receives an object: ${json}`,
  ).toBe(true);
  return value as ConfigObject;
}

/** Every key of `tree` at any depth, as written — never joined into a path. */
function keysOf(tree: ConfigObject): string[] {
  return Object.entries(tree).flatMap(([key, value]) => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? [key, ...keysOf(value as ConfigObject)]
      : [key]
  ));
}

describe('the "Reading config in code" sample reads back what it prints', () => {
  test.each([...SAMPLES])('$language: the override reaches the path the sample reads', async ({ page, heading }) => {
    const sample = sampleUnder(page, heading);
    const literal = /withConfig\((\{[\s\S]*?\})\s*\)/.exec(sample)?.[1];
    const path = /\.getDuration\('([^']+)'\)/.exec(sample)?.[1];
    const printed = /→\s*(\d+)/.exec(sample)?.[1];
    expect(literal, 'the sample hands withConfig an object literal').toBeDefined();
    expect(path, 'the sample reads a duration back').toBeDefined();
    expect(printed, 'the sample prints the value it reads back').toBeDefined();
    const overrides = valueOfLiteral(literal!);

    const actorSystemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig(overrides);
    const system = ActorSystem.create('my-app', actorSystemOptions);
    try {
      const readBack = system.config.getDuration(path!);
      expect(
        readBack,
        `${heading}: withConfig(${JSON.stringify(overrides)}) reads back ${readBack} at `
        + `${path}, but the sample prints ${printed}.  An object's keys are not paths — a `
        + 'dotted key is one literal segment that no lookup reaches, so nest the object.',
      ).toBe(Number(printed));
      expect(
        readBack,
        `${heading}: the sample prints the reference default, so it would read the same `
        + 'with its override removed — it demonstrates nothing.',
      ).not.toBe(Config.loadReference().getDuration(path!));
    } finally {
      await system.terminate();
    }

    // The replay above sees only the key the sample reads back.  A second
    // dotted key beside it — `'actor-ts.remote.untrusted-mode': true` reads
    // back `false` the same way — would pass it, so the shape is checked too:
    // a lookup splits its path on dots, so a key holding one is unreachable.
    expect(
      keysOf(overrides).filter((key) => key.includes('.')),
      `${heading}: a withConfig key contains a dot.  It stays one literal segment that `
      + 'no path reaches, so the override is dropped without a word — nest the object.',
    ).toEqual([]);
  });
});
