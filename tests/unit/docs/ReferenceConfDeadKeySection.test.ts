import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseHocon, isPlainObject } from '../../../src/config/HoconParser.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { UNPUBLISHED_LEAVES } from '../../util/ConfigReaderRegistry.js';

/**
 * The reference.conf page's account of the dead-key gate matches the gate
 * (#1425).
 *
 * The section promised a build failure for a key nothing reads while the
 * test behind it searched source text, which a comment or a sibling's
 * accessor satisfied.  The gate now perturbs each leaf through a registry of
 * readers, and the section says so in two languages.  This holds the part of
 * that account a test can hold: both pages name the same things, and the
 * settings they name as outside the gate are outside it — neither published
 * for the gate to change nor introduced by the registry.  When a later
 * change brings one of them in, the page's sentence becomes false, and this
 * fails until the sentence goes.
 *
 * What it cannot see is the prose itself: a sentence asserting the opposite
 * of what the gate does keeps every check here green.
 */

const DOCUMENTATION_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

const SECTIONS = [
  { language: 'en', page: join(DOCUMENTATION_ROOT, 'reference', 'reference-conf.mdx'), heading: '## No dead keys' },
  { language: 'de', page: join(DOCUMENTATION_ROOT, 'de', 'reference', 'reference-conf.mdx'), heading: '## Keine toten Keys' },
] as const;

/** The settings the section says the gate does not reach, as the page spells them. */
const OUTSIDE_THE_GATE = ['coordinated-shutdown.phases', 'replication.data-centers'] as const;

/** The lines under a `## ` heading, up to the next one. */
function sectionOf(page: string, heading: string): string[] {
  const lines = readFileSync(page, 'utf8').split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `${heading} is missing from ${page}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Every inline code span of the section's prose, MDX comments dropped. */
function codeSpansOf(section: readonly string[]): Set<string> {
  const prose = section.join(' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
  return new Set([...prose.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
}

function leafPaths(tree: ConfigObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

/** Every key the gate changes: the leaves reference.conf publishes, and the ones the registry introduces. */
const gatedKeys = [...leafPaths(parseHocon(REFERENCE_CONF)), ...UNPUBLISHED_LEAVES.keys()];

const spans = new Map(SECTIONS.map(({ language, page, heading }) => [language, codeSpansOf(sectionOf(page, heading))]));

describe('the reference.conf page describes the dead-key gate as it is (#1425)', () => {
  test('both languages name the same things', () => {
    expect([...spans.get('de')!].sort()).toEqual([...spans.get('en')!].sort());
  });

  for (const { language } of SECTIONS) {
    test(`it names the gate, its registry and the consumer pin (${language})`, () => {
      expect([...spans.get(language)!]).toEqual(expect.arrayContaining([
        'tests/unit/config/NoDeadConfigKeys.test.ts',
        'tests/util/ConfigReaderRegistry.ts',
        'tests/unit/config/ConsumersReadThroughRegisteredReaders.test.ts',
      ]));
    });

    test(`it names what the gate leaves out (${language})`, () => {
      expect([...spans.get(language)!]).toEqual(expect.arrayContaining([...OUTSIDE_THE_GATE]));
    });
  }

  test.each([...OUTSIDE_THE_GATE])('%s is outside the gate, as the page says', (setting) => {
    const gated = gatedKeys.filter((key) => key === `actor-ts.${setting}` || key.endsWith(`.${setting}`)
      || key.startsWith(`actor-ts.${setting}.`));
    expect(gated, `the gate changes ${gated.join(', ')} now: drop ${setting} from both pages' list of what it leaves out`)
      .toEqual([]);
  });

  test('the gate still has keys to change', () => {
    // Guards the guard: an empty key list would make every setting "outside".
    expect(gatedKeys.length).toBeGreaterThan(400);
    expect(gatedKeys).toContain('actor-ts.coordinated-startup.phases');
  });
});
