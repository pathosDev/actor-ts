import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { readDowningFromConfig } from '../../../src/cluster/downing/DowningFromConfig.js';
import { readSplitBrainResolverOptionsFromConfig } from '../../../src/cluster/downing/SplitBrainResolverOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';

/**
 * The `application.conf` sample at the top of the configuration page shows
 * `actor-ts.cluster.split-brain-resolver` at the defaults the framework ships,
 * in both languages (#1459).
 *
 * #838 added the block and documented it in the key table and in both
 * `reference-conf.mdx` pages, but left this sample alone, and #839 then gave
 * the block two more leaves.  Nothing noticed, because nothing read this fence
 * for anything but spelling: `HoconFenceKeys` checks that its keys are
 * kebab-case, and `ReferenceConfDocs` pins `reference-conf.mdx`, not this page.
 *
 * The assertions go through the code rather than through the text.  The
 * sample's leaves are read with the readers that consume the block and compared
 * with what the same readers make of the bundled reference, and the value list
 * on `active-strategy` is compared with the list the selector itself prints
 * when it refuses an unknown strategy — so a strategy that becomes selectable,
 * or stops being, turns this red until the sample says so.
 *
 * The section used to be headed "A complete `application.conf`", and it never
 * was one: before the #887 configuration wave it showed 40 of the bundled
 * reference's 174 leaves, and the wave nearly tripled the reference.  Growing
 * the sample to every key would duplicate `reference-conf.mdx`, so it is headed
 * as the representative sample it is and links the page that does carry every
 * key.
 */

const DOCUMENTATION_ROOT = join(
  import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs',
);

/**
 * The sample on each page, found by its section heading — the pages are
 * mirrors — and the page the section names for the full list of keys.
 */
const SAMPLES = [
  {
    language: 'en',
    page: join(DOCUMENTATION_ROOT, 'reference', 'configuration.mdx'),
    heading: '## A typical `application.conf`',
    fullList: '/reference/reference-conf/',
  },
  {
    language: 'de',
    page: join(DOCUMENTATION_ROOT, 'de', 'reference', 'configuration.mdx'),
    heading: '## Eine typische `application.conf`',
    fullList: '/de/reference/reference-conf/',
  },
] as const;

const RESOLVER = ConfigKeys.cluster.splitBrainResolver;

/** The lines of the `## ` section headed exactly `heading`, heading excluded. */
function sectionLines(page: string, heading: string): string[] {
  const lines = readFileSync(page, 'utf8').split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `${heading} is missing from ${page}`).toBeGreaterThan(-1);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, next === -1 ? undefined : next);
}

/**
 * What the section renders as prose: fences, MDX comments and code spans are
 * left out, because a link written inside any of them is not a link.
 */
function sectionProse(page: string, heading: string): string {
  let inFence = false;
  return sectionLines(page, heading)
    .filter((line) => {
      if (line.startsWith('```')) inFence = !inFence;
      else if (!inFence) return true;
      return false;
    })
    .join('\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/`[^`]*`/g, '');
}

/** The lines of the first `hocon` fence of the `## ` section headed exactly `heading`. */
function sampleLines(page: string, heading: string): string[] {
  const section = sectionLines(page, heading);
  const open = section.findIndex((line) => /^```hocon\s*$/.test(line));
  expect(open, `${heading} has no hocon fence`).toBeGreaterThan(-1);
  const close = section.findIndex((line, index) => index > open && line.startsWith('```'));
  return section.slice(open + 1, close);
}

/** The sample as a config of its own — no reference underneath it. */
function sampleConfig(page: string, heading: string): Config {
  return Config.parseString(sampleLines(page, heading).join('\n'));
}

/**
 * The strategies `active-strategy` accepts, as the selector lists them when it
 * refuses an unknown one.  The list is module-private in `DowningFromConfig.ts`
 * and this refusal is the one place it is published, which is also the place a
 * reader of the sample would meet it.
 */
function selectableStrategies(): string[] {
  const unknown = Config.parseString(`${RESOLVER.activeStrategy} = no-such-strategy`);
  let refusal = '';
  try {
    readDowningFromConfig(unknown);
  } catch (error) {
    refusal = (error as Error).message;
  }
  const listed = /must be one of (.+) \(got /.exec(refusal)?.[1];
  expect(
    listed,
    `the selector accepted an unknown strategy, or reworded its refusal: "${refusal}"`,
  ).toBeDefined();
  return listed!.split(' | ');
}

describe('the application.conf sample on the configuration page', () => {
  test.each([...SAMPLES])('$language: links the full list of keys from the sample', ({ page, heading, fullList }) => {
    expect(
      sectionProse(page, heading),
      `${heading} shows a selection of blocks; its prose has to link ${fullList}, `
      + 'the page that carries every key.',
    ).toContain(`](${fullList})`);
  });

  test.each([...SAMPLES])('$language: shows split-brain-resolver at the shipped defaults', ({ page, heading }) => {
    const sample = sampleConfig(page, heading);
    const reference = Config.loadReference();
    for (const key of [RESOLVER.activeStrategy, RESOLVER.stableAfter, RESOLVER.downAllWhenUnstable]) {
      expect(sample.hasPath(key), `${heading} does not show ${key}`).toBe(true);
    }
    expect(
      sample.getString(RESOLVER.activeStrategy),
      `${heading}: active-strategy is not the shipped default`,
    ).toBe(reference.getString(RESOLVER.activeStrategy));
    expect(
      readSplitBrainResolverOptionsFromConfig(sample),
      `${heading}: stable-after / down-all-when-unstable read back other than the shipped defaults`,
    ).toStrictEqual(readSplitBrainResolverOptionsFromConfig(reference));
  });

  test.each([...SAMPLES])('$language: lists the strategies the selector accepts, and no other', ({ page, heading }) => {
    const line = sampleLines(page, heading).find((candidate) => /^\s*active-strategy\s*=/.test(candidate));
    expect(line, `${heading} has no active-strategy line`).toBeDefined();
    const listed = line!.split('#')[1]?.split('|').map((name) => name.trim()) ?? [];
    expect([...listed].sort(), `${heading}: ${line!.trim()}`).toEqual([...selectableStrategies()].sort());
  });

  test('the German sample is the English one, comments aside', () => {
    // Prose comments are translated, so the fences differ byte-wise by design;
    // what may not differ is what they configure.
    const [english, german] = SAMPLES.map(({ page, heading }) => sampleConfig(page, heading).toJSON());
    expect(german, 'the German sample configures something the English one does not')
      .toStrictEqual(english);
  });
});
