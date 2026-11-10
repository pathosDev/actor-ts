import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { isPlainObject, parseHocon } from '../../../src/config/HoconParser.js';
import type { ConfigObject, ConfigValue } from '../../../src/config/HoconParser.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { baselineOf, observeLeaf, perturbationFor, type ConfigProbe } from '../../util/ConfigPerturbation.js';
import { CONFIG_READER_REGISTRY, entryLabel } from '../../util/ConfigReaderRegistry.js';

/**
 * **Every line a HOCON sample on these pages shows does something.**
 *
 * `HoconFenceKeys` holds a fence's keys to kebab-case and `NoDeadConfigKeys`
 * holds `reference.conf`'s leaves to a reader, but nothing asked whether a key
 * a page tells its reader to write is read where the page writes it.  The
 * actor-system page's `application.conf` sample set `dispatcher.throughput`
 * without `dispatcher.default = "throughput"`, and the dispatcher reader takes
 * the count only under that kind — so under the shipped `hybrid` default the
 * line configured nothing, and a reader who copied it got the default
 * dispatcher with no word about it.
 *
 * So each sample is laid over the reference configuration, as an
 * `application.conf` is, and each leaf it sets is perturbed there the way the
 * dead-key gate perturbs a reference leaf — kept to its kind, with the gate's
 * overrides — against every registered reader.  A leaf no reader answers to,
 * in the context the sample itself sets up, is a line that does nothing.
 *
 * Scoped to the pages listed below rather than to the whole site: a sample
 * elsewhere that sets a key only to show its spelling, or one a reader the
 * registry does not run, would need a decision this guard should not make for
 * it.  A page joins by being listed.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** The pages whose HOCON samples are held to a reader, relative to the docs root; the German mirror sits under `de/`. */
const PAGES: readonly string[] = [
  'fundamentals/actor-system.mdx',
  'persistence/overview.mdx',
];

const LANGUAGES = [
  ['English', ''],
  ['German', 'de'],
] as const;

/** The opening fence of a HOCON sample, indented or carrying a title, as `HoconFenceKeys` reads it. */
const HOCON_FENCE_OPEN = /^[ \t]*```hocon(?:[ \t].*)?$/;
const FENCE_DELIMITER = /^[ \t]*```/;

type Fence = {
  /** 1-based line of the opening marker. */
  readonly line: number;
  readonly body: string;
};

function hoconFences(text: string): Fence[] {
  const fences: Fence[] = [];
  const lines = text.split(/\r?\n/);
  let open: { readonly line: number; readonly body: string[] } | null = null;
  for (const [index, line] of lines.entries()) {
    if (open === null) {
      if (HOCON_FENCE_OPEN.test(line)) open = { line: index + 1, body: [] };
      continue;
    }
    if (FENCE_DELIMITER.test(line)) {
      fences.push({ line: open.line, body: open.body.join('\n') });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return fences;
}

/** Every dotted leaf path in a parsed sample, with the value it sets. */
function leavesOf(tree: ConfigObject, prefix = ''): Array<readonly [string, ConfigValue]> {
  const out: Array<readonly [string, ConfigValue]> = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...leavesOf(value, path));
    else out.push([path, value]);
  }
  return out;
}

/**
 * Every registered reader, over the sample alone.  Not the registry's
 * contexts: a context lays a selector of its own over the config — the
 * dispatcher reader's selects the `throughput` kind — so a sample that never
 * selects the branch would be read in it anyway, and the line the sample
 * forgot to make work would pass for one that does.  The sample has to set up
 * its own context.
 */
const probes: readonly ConfigProbe[] = CONFIG_READER_REGISTRY.map((entry) => ({
  label: entryLabel(entry),
  read: entry.read,
}));

const reference = Config.parseString(REFERENCE_CONF);

type SampleLeaf = {
  readonly language: string;
  readonly page: string;
  readonly fenceLine: number;
  readonly leaf: string;
  readonly unread: boolean;
};

/** Every leaf of every sample on the listed pages, and whether some reader answers to it there. */
function sampleLeaves(): SampleLeaf[] {
  const out: SampleLeaf[] = [];
  for (const [language, directory] of LANGUAGES) {
    for (const page of PAGES) {
      const file = join(DOCS_ROOT, directory, page);
      for (const fence of hoconFences(readFileSync(file, 'utf8'))) {
        const sample = reference.merge(Config.parseString(fence.body));
        const baselines = probes.map((probe) => baselineOf(probe, sample));
        for (const [leaf, literal] of leavesOf(parseHocon(fence.body))) {
          const verdict = observeLeaf(perturbationFor(leaf, literal), baselines);
          out.push({ language, page, fenceLine: fence.line, leaf, unread: verdict.observedBy.length === 0 });
        }
      }
    }
  }
  return out;
}

const leaves = sampleLeaves();

describe('the HOCON samples on the startup and persistence pages configure what they show', () => {
  test('the pages carry samples at all', () => {
    // Guards the guard: a fence pattern that stopped matching would pass
    // every case below by having no case.
    for (const [language] of LANGUAGES) {
      for (const page of PAGES) {
        expect(
          leaves.some((entry) => entry.language === language && entry.page === page),
          `${language} ${page} has no HOCON sample with a leaf`,
        ).toBe(true);
      }
    }
  });

  test.each(leaves.map((entry) => [`${entry.language} ${entry.page}:${entry.fenceLine} ${entry.leaf}`, entry] as const))(
    '%s is read where the sample sets it',
    (_label, entry) => {
      expect(
        entry.unread,
        `${entry.leaf}, as the sample on ${entry.page} (line ${entry.fenceLine}) sets it, is read by none of the `
        + `${probes.length} registered readers: changed to another value of its kind, no answer moved.  A line that `
        + 'configures nothing teaches the reader a setting that does not exist — set what it depends on in the same '
        + 'sample, or drop it.',
      ).toBe(false);
    },
  );
});
