/**
 * #1461 — the configuration page names the dispatcher that runs when nobody
 * chose one, and nothing held it to the code.
 *
 * #1205 made `HybridDispatcher` the default and updated the two pages that
 * carry the reference file verbatim.  The configuration page went on saying
 * `"immediate"` in two places — the `actor-ts.dispatcher` table and the
 * `application.conf` sample — in both languages, and never listed `hybrid` at
 * all.  `DocumentedDefaults` could not notice: it reads `REFERENCE_CONF`, which
 * already said `hybrid`, and never opens a page, so it ran green over the drift.
 *
 * So this file reads the pages, and everything it compares them with comes from
 * the code rather than from a second copy of the words: the default from the
 * bundled reference, the kinds from the reader that takes them, and the
 * fallback from the dispatcher a system actually builds for a name no
 * dispatcher answers to.  The table row has to name every kind, mark the
 * shipped one as the default, and say what an unset or unrecognised value
 * falls back to; the sample has to show the shipped default and list every
 * kind beside it.
 *
 * Know the guard's reach: `test.yml` filters on `src/**` and `tests/**`, so a
 * commit that touches only a page does not run it in CI (#470).  Run it
 * locally after editing either page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ActorSystem, readDispatcherOptionsFromConfig } from '../../../src/ActorSystem.js';
import type { DispatcherKind } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { HybridDispatcher, ImmediateDispatcher, MicrotaskDispatcher, ThroughputDispatcher } from '../../../src/Dispatcher.js';
import type { Dispatcher } from '../../../src/Dispatcher.js';
import { NoopLogger } from '../../../src/Logger.js';

/**
 * Every kind `actor-ts.dispatcher.default` takes, with the class it builds.
 *
 * A record over `DispatcherKind`, so a kind the union gains and this table
 * lacks is a compile error under `typecheck:dev`, and so is a key here that is
 * no kind at all.  The first test then asks the reader whether it takes each
 * one, which closes the other gap: a name the union carries and the reader
 * refuses.
 */
const DISPATCHER_OF_KIND = {
  hybrid: HybridDispatcher,
  immediate: ImmediateDispatcher,
  microtask: MicrotaskDispatcher,
  throughput: ThroughputDispatcher,
} satisfies Record<DispatcherKind, new (...parameters: never[]) => Dispatcher>;

const KINDS = Object.keys(DISPATCHER_OF_KIND) as DispatcherKind[];

/** A name no dispatcher answers to, for the fallback. */
const UNRECOGNISED_KIND = 'no-such-dispatcher';

const DOCUMENTATION_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/**
 * The configuration page in each language.  The pages are mirrors, so the
 * table and the sample are found the same way in both; what differs is the
 * sample's heading and the two phrases the row is read by — the marker after
 * the default kind, and the sentence that names the fallback.
 */
const PAGES = [
  {
    language: 'en',
    page: join(DOCUMENTATION_ROOT, 'reference', 'configuration.mdx'),
    sampleHeading: '## A typical `application.conf`',
    defaultMarker: '(default)',
    fallback: /falls back to `([^`]+)`/,
  },
  {
    language: 'de',
    page: join(DOCUMENTATION_ROOT, 'de', 'reference', 'configuration.mdx'),
    sampleHeading: '## Eine typische `application.conf`',
    defaultMarker: '(Default)',
    fallback: /fällt auf `([^`]+)` zurück/,
  },
] as const;

const TABLE_HEADING = '### `actor-ts.dispatcher`';
const ROW_PREFIX = '| `dispatcher.default` |';

/** The value `reference.conf` ships, which every page has to publish. */
const shippedDefault = Config.loadReference().getString(ConfigKeys.dispatcher.default);

/**
 * The lines from `heading` to the next heading of the same depth or shallower,
 * as the page renders them: lines inside a fence and MDX comments are dropped,
 * because a row written in either is not a row anyone reads.
 */
function renderedSection(page: string, heading: string): string[] {
  const lines = readFileSync(page, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `${heading} is missing from ${page}`).toBeGreaterThan(-1);
  const depth = heading.indexOf(' ');
  const end = lines.findIndex((line, index) => {
    const marks = /^(#+) /.exec(line)?.[1];
    return index > start && marks !== undefined && marks.length <= depth;
  });
  let inFence = false;
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return false;
    }
    return !inFence;
  });
}

/** The purpose cell of the one `dispatcher.default` row, and its default cell. */
function defaultRow(page: string): { readonly published: string; readonly purpose: string } {
  const rows = renderedSection(page, TABLE_HEADING).filter((line) => line.startsWith(ROW_PREFIX));
  expect(rows, `${page}: the ${TABLE_HEADING} table must have exactly one dispatcher.default row`).toHaveLength(1);
  const cells = rows[0]!.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
  expect(cells, `${page}: ${rows[0]}`).toHaveLength(3);
  return { published: cells[1]!, purpose: cells[2]! };
}

/** Every code span in `text` that is a bare lowercase word — the shape a kind is written in. */
function kindShapedSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((span) => span[1]!).filter((span) => /^[a-z]+$/.test(span));
}

/** The `default = …` line of the sample's `dispatcher` block, and the sample as a config of its own. */
function dispatcherSample(page: string, heading: string): { readonly line: string; readonly sample: Config } {
  const section = readFileSync(page, 'utf8').split(/\r?\n/);
  const start = section.indexOf(heading);
  expect(start, `${heading} is missing from ${page}`).toBeGreaterThan(-1);
  const open = section.findIndex((line, index) => index > start && /^```hocon\s*$/.test(line));
  const close = section.findIndex((line, index) => index > open && line.startsWith('```'));
  expect(open, `${heading} has no hocon fence`).toBeGreaterThan(start);
  const fence = section.slice(open + 1, close);
  const block = fence.findIndex((line) => /^\s*dispatcher\s*\{/.test(line));
  expect(block, `${heading}: the sample has no dispatcher block`).toBeGreaterThan(-1);
  const blockEnd = fence.findIndex((line, index) => index > block && /^\s*\}/.test(line));
  const line = fence.slice(block + 1, blockEnd).find((candidate) => /^\s*default\s*=/.test(candidate));
  expect(line, `${heading}: the sample's dispatcher block has no default line`).toBeDefined();
  return { line: line!, sample: Config.parseString(fence.join('\n')) };
}

async function dispatcherBuiltFor(kind: string): Promise<Dispatcher> {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withConfig({ 'actor-ts': { dispatcher: { default: kind } } });
  const system = ActorSystem.create('dispatcher-default-documented', options);
  try {
    return system.dispatcher;
  } finally {
    await system.terminate();
  }
}

describe('the configuration page publishes the dispatcher the code runs by default', () => {
  test('every kind in the table is one the reader takes, and the shipped default is among them', () => {
    for (const kind of KINDS) {
      const configured = Config.parseString(`${ConfigKeys.dispatcher.default} = "${kind}"`);
      expect(readDispatcherOptionsFromConfig(configured), `the reader refuses "${kind}"`).toEqual({ kind });
    }
    expect(KINDS).toContain(shippedDefault as DispatcherKind);
  });

  test.each([...PAGES])('$language: the dispatcher.default row publishes the shipped default', ({ page }) => {
    expect(
      defaultRow(page).published,
      `${page}: reference.conf ships ${ConfigKeys.dispatcher.default} = "${shippedDefault}"`,
    ).toBe(`\`"${shippedDefault}"\``);
  });

  test.each([...PAGES])('$language: the row names every kind the reader takes, and no other', ({ page }) => {
    const named = kindShapedSpans(defaultRow(page).purpose);
    expect([...new Set(named)].sort(), `${page}: the kinds the dispatcher.default row names`).toEqual([...KINDS].sort());
  });

  test.each([...PAGES])('$language: the row marks the shipped default as the default, and nothing else', ({ page, defaultMarker }) => {
    const { purpose } = defaultRow(page);
    const marked = [...purpose.matchAll(/`([^`]+)` \(([^)]+)\)/g)]
      .filter((match) => `(${match[2]})` === defaultMarker)
      .map((match) => match[1]);
    expect(marked, `${page}: the kinds the row marks ${defaultMarker}`).toEqual([shippedDefault]);
  });

  test.each([...PAGES])('$language: the fallback the row names is the dispatcher an unrecognised kind builds', async ({ page, fallback }) => {
    const documented = fallback.exec(defaultRow(page).purpose)?.[1];
    expect(documented, `${page}: the row does not say what an unset or unrecognised value falls back to`).toBeDefined();
    expect(KINDS, `${page}: the row falls back to "${documented}", which is no kind`).toContain(documented as DispatcherKind);
    // An unset key reads exactly as an unrecognised one, so building the
    // second is building the first too: the reference layer under every
    // system always sets the key, so only the reader can show "unset".
    expect(readDispatcherOptionsFromConfig(Config.empty())).toEqual(
      readDispatcherOptionsFromConfig(Config.parseString(`${ConfigKeys.dispatcher.default} = "${UNRECOGNISED_KIND}"`)),
    );
    expect(await dispatcherBuiltFor(UNRECOGNISED_KIND)).toBeInstanceOf(DISPATCHER_OF_KIND[documented as DispatcherKind]);
  });

  test.each([...PAGES])('$language: the application.conf sample shows the shipped default and lists every kind', ({ page, sampleHeading }) => {
    const { line, sample } = dispatcherSample(page, sampleHeading);
    expect(sample.getString(ConfigKeys.dispatcher.default), `${sampleHeading}: ${line.trim()}`).toBe(shippedDefault);
    const listed = line.split('#')[1]?.split('|').map((name) => name.trim()) ?? [];
    expect([...listed].sort(), `${sampleHeading}: ${line.trim()}`).toEqual([...KINDS].sort());
  });
});
