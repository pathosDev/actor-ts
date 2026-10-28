/**
 * #1426 — the pages that say what the failure detector does with a peer it
 * declares `down`, held to the shipped default.
 *
 * `actor-ts.cluster.failure-detector.auto-down` ships `on`: with no downing
 * strategy configured, the detector removes a peer silent past `down-after`,
 * so an n-node cluster keeps running down to its last available node.  `off`
 * is the opt-out that parks the peer at `unreachable`.  For a few weeks the
 * default was the other way round, and the prose written for it said so in
 * some forty places across both languages — tables, samples, asides, the
 * testkit pages and the examples' comments.  None of it was checked:
 * `DocumentedDefaults` pins `reference/reference-conf.mdx` alone, so the
 * configuration reference's table and sample kept whatever they said with
 * every docs test green (#1426).
 *
 * Two kinds of assertion, both deliberately on text a reader acts on:
 *
 * - **Where a page states the default in structure** — the configuration
 *   reference's `application.conf` sample and key table, the decision table
 *   on the failure-detector page, the removal table on the downing page — the
 *   removal is the default and parking the opt-out.  The sample is parsed, so a
 *   misspelt key fails as surely as a wrong value.
 * - **The phrasings the parking default was written in** must not come back on
 *   a page or in an example that discusses downing.  A merge that resolves a
 *   conflict by taking the old side is the likeliest way they would, and it
 *   brings the old sentence back verbatim.  This half is a list of phrasings,
 *   not an understanding of them: a paraphrase gets past it.
 *
 * The shipped value is read from the bundled `reference.conf`, so the
 * structured half follows it wherever it moves; the phrase list is written for
 * the removal default and says so when it stops being the one that ships.  A
 * third, smaller part holds the readiness page to what the `cluster-transport`
 * check expects of a peer parked under the opt-out.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCUMENTATION = 'docs/src/content/docs';
const AUTO_DOWN = 'actor-ts.cluster.failure-detector.auto-down';

const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

/**
 * `failure-detector.auto-down` as the bundled `reference.conf` ships it
 * (#1426), read through the parser an `application.conf` goes through, so the
 * configuration reference's sample and key table follow the shipped value
 * rather than a copy of it.  `DocumentedDefaults` holds the bundled file and
 * `DEFAULT_FAILURE_DETECTOR_AUTO_DOWN` to each other.
 */
const SHIPPED_AUTO_DOWN = Config.parseString(REFERENCE_CONF).getBoolean(AUTO_DOWN);

/** How the pages spell the shipped value of the switch, and the opt-out's. */
const SHIPPED_SPELLING = SHIPPED_AUTO_DOWN ? 'auto-down = on' : 'auto-down = off';
const OPT_OUT_SPELLING = SHIPPED_AUTO_DOWN ? 'auto-down = off' : 'auto-down = on';

type Language = {
  readonly name: string;
  /** Path prefix under the documentation root: `''` or `'de/'`. */
  readonly prefix: string;
  /** How a table cell marks the shipped behaviour. */
  readonly defaultMarker: RegExp;
  /** How a table cell marks the opt-out. */
  readonly optOutMarker: RegExp;
  /** The configuration reference's sample section. */
  readonly sampleHeading: string;
};

const LANGUAGES: readonly Language[] = [
  {
    name: 'English',
    prefix: '',
    defaultMarker: /\bthe default\b/i,
    optOutMarker: /\bopt-out\b/i,
    sampleHeading: '## A typical `application.conf`',
  },
  {
    name: 'German',
    prefix: 'de/',
    defaultMarker: /\bder Default\b/,
    optOutMarker: /\bOpt-out\b/,
    sampleHeading: '## Eine typische `application.conf`',
  },
];

/** The body of the first `hocon` fence after `heading`, which has to be found. */
function firstHoconFenceAfter(path: string, text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`${path}: the heading "${heading}" is gone — re-point this guard.`);
  const open = lines.findIndex((line, index) => index > start && /^```hocon\b/.test(line));
  const close = lines.findIndex((line, index) => index > open && /^```\s*$/.test(line));
  if (open < 0 || close < 0) throw new Error(`${path}: no hocon fence follows "${heading}".`);
  return lines.slice(open + 1, close).join('\n');
}

const page = (language: Language, path: string): string => `${DOCUMENTATION}/${language.prefix}${path}`;

/** The cells of a Markdown table row, outer pipes dropped. */
function cellsOf(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** The table rows of a page whose first cell matches `firstCell`. */
function rowsWhere(text: string, firstCell: RegExp): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map(cellsOf)
    .filter((cells) => firstCell.test(cells[0] ?? ''));
}

describe('#1426 — the pages state the shipped auto-down default', () => {
  for (const language of LANGUAGES) {
    test(`${language.name}: the configuration reference's sample sets auto-down to the shipped value`, () => {
      // Parsed rather than matched, so a misspelt key fails as surely as a
      // wrong value: a sample a reader copies with `auto-dwn = on` in it
      // configures nothing, and only a parser says so.
      const path = page(language, 'reference/configuration.mdx');
      const sample = Config.parseString(firstHoconFenceAfter(path, read(path), language.sampleHeading));
      expect(sample.hasPath(AUTO_DOWN), `${path}: the sample's failure-detector block names no auto-down key.`).toBe(true);
      expect(sample.getBoolean(AUTO_DOWN), `${path}: the sample sets ${AUTO_DOWN} to the opposite of what ships.`)
        .toBe(SHIPPED_AUTO_DOWN);
    });

    test(`${language.name}: the configuration reference's key table gives auto-down the shipped default`, () => {
      const path = page(language, 'reference/configuration.mdx');
      const rows = rowsWhere(read(path), /^`cluster\.failure-detector\.auto-down`$/);
      expect(rows.length, `${path}: the key table has no single row for cluster.failure-detector.auto-down.`).toBe(1);
      expect(rows[0]![1], `${path}: the key table's default for auto-down is not the shipped one.`)
        .toBe(SHIPPED_AUTO_DOWN ? '`on`' : '`off`');
    });

    test(`${language.name}: the failure-detector decision table marks the shipped row as the default`, () => {
      const path = page(language, 'cluster/failure-detector.mdx');
      const rows = rowsWhere(read(path), /^`down`/);
      const defaults = rows.filter((cells) => language.defaultMarker.test(cells[0]!));
      expect(
        defaults.map((cells) => cells[0]),
        `${path}: the decision table has to mark exactly one \`down\` row as the default, and it is the `
        + `row for the shipped \`${SHIPPED_SPELLING}\`.`,
      ).toEqual([expect.stringContaining(`\`${SHIPPED_SPELLING}\``)]);
      for (const cells of rows.filter((row) => row[0]!.includes(`\`${OPT_OUT_SPELLING}\``))) {
        expect(cells[0], `${path}: the \`${OPT_OUT_SPELLING}\` row is the opt-out, not the default.`)
          .toMatch(language.optOutMarker);
      }
    });

    test(`${language.name}: the downing page's removal table marks the shipped route as the default`, () => {
      const path = page(language, 'cluster/downing-strategies.mdx');
      const rows = rowsWhere(read(path), /auto-down/);
      const shipped = rows.filter((cells) => cells[0]!.includes(SHIPPED_SPELLING));
      const optOut = rows.filter((cells) => cells[0]!.includes(OPT_OUT_SPELLING));
      expect(shipped.length, `${path}: no removal-table row for the shipped \`${SHIPPED_SPELLING}\`.`).toBe(1);
      expect(optOut.length, `${path}: no removal-table row for the opt-out \`${OPT_OUT_SPELLING}\`.`).toBe(1);
      expect(shipped[0]![0], `${path}: the shipped route is the default.`).toMatch(language.defaultMarker);
      expect(optOut[0]![0], `${path}: the other route is the opt-out.`).toMatch(language.optOutMarker);
      expect(optOut[0]![0], `${path}: the opt-out is not the default.`).not.toMatch(language.defaultMarker);
    });
  }
});

/**
 * A phrasing the parking default was written in.  `alongside`, when present,
 * has to match the same sentence too — "opt-in" is only the old claim in a
 * sentence about `auto-down`.  `unless` exempts a sentence that qualifies the
 * claim into the corrected one — "with a strategy configured, the detector
 * only parks" is true.
 */
type OldPhrasing = {
  readonly pattern: RegExp;
  readonly alongside?: RegExp;
  readonly unless?: RegExp;
};

const ABOUT_AUTO_DOWN = /auto-?down/i;

/** Where a sentence names the opt-out or a strategy, "parks" is the corrected claim, not the old one. */
const QUALIFIED = /opt-out|auto-down`?\s*=\s*`?off|\bwith (?:one|a strategy|a downing strategy) configured\b|ist eine konfiguriert|mit konfigurierter Strategie/i;

const OLD_PHRASINGS: readonly OldPhrasing[] = [
  // English.
  { pattern: /auto-down`?\s*(?:=\s*)?`?off`?\s*\((?:the )?default\)/i },
  { pattern: /auto-down`?\s*(?:=\s*)?`?off`?,\s*the default\b/i },
  { pattern: /\boff by default\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bships off\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bat its default `?off\b/i },
  { pattern: /\bthe shipped `?false\b/i, alongside: /auto-?down|\bcrashed\b|\bfailure detector\b/i },
  { pattern: /\bby default,? (?:it |the detector |the failure detector )?(?:only )?parks?\b/i },
  { pattern: /\bthe default (?:only )?parks\b/i },
  { pattern: /\bby the default with no strategy\b/i },
  // "The default ... removes nothing", unless an opt-out or a strategy is
  // named in between — "under the default X; with a strategy or under the
  // opt-out, nobody" is the corrected sentence, not the old one.
  {
    pattern:
      /\b(?:the default|by default)\b(?:(?!opt-out|auto-down`?\s*=\s*`?off|strateg)[\s\S])*?\b(?:removes|evicts) (?:nothing|nobody|no one)\b/i,
  },
  { pattern: /\bremoves nobody\b/i },
  { pattern: /\bthe default is manual\b/i },
  { pattern: /\bopt(?:s|ed)?[- ]in(?:to)?\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /auto-down = on`? (?:opts|restores)\b/i },
  {
    pattern: /\bwith(?:out)? (?:no |a )?(?:downing )?strategy\b[\s\S]*?\b(?:would )?only parks?\b/i,
    unless: QUALIFIED,
  },
  { pattern: /\bwithout (?:a )?downing\b[\s\S]*?\bparks?\b/i, unless: QUALIFIED },
  { pattern: /\bdetector only parks\b/i, unless: QUALIFIED },
  { pattern: /\bnothing removes (?:an? )(?:unreachable |crashed |silent )?(?:peer|member|node)\b/i },
  { pattern: /\bthe way out of the default\b/i },
  { pattern: /`off` is the default\b/i },
  { pattern: /\bdefaults? to `?(?:off|false)`?/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bby default\b[^.]{0,80}?\bis parked\b/i },
  { pattern: /\bby default\b[\s\S]{0,80}?auto-down`?\s*=\s*`?off\b/i, unless: /\bopt-out\b/i },
  // The startup refusal of `auto-down` beside a strategy is gone: a configured
  // strategy decides every removal whatever the switch says.
  { pattern: /\brefused\b\**(?: at startup)? beside a (?:configured )?strategy\b|\bbeside a (?:configured )?strategy is refused\b/i },
  // About a crashed *node*: the same words about a restarting actor and the
  // default supervisor strategy are true and stay.
  {
    pattern: /\bthe default\b[^.]*?\bno (?:node-loss )?`?Terminated\b/i,
    alongside: /\bnode(?:'s|s)?\b/i,
    unless: QUALIFIED,
  },
  // `auto-down = on` listed beside a strategy and an operator as one more way to
  // remove a parked member — the removers of a member the default never parks.
  { pattern: /\bstrateg\w*\b[^.]{0,40}`(?:failure-detector\.)?auto-down = on`[^.]{0,20}\b(?:or|oder) (?:an? |ein )?operator\b/i },
  // A heartbeat offered as the way back without the partition caveat: after a
  // symmetric partition heals, neither side heartbeats the other (#930).
  { pattern: /\buntil it heartbeats again\b/i },
  { pattern: /\bif heartbeats resume\b/i },
  // German.
  { pattern: /auto-down`?\s*(?:auf\s*)?(?:=\s*)?`?(?:off|aus)`?\s*\((?:der|dem) Default\)/ },
  { pattern: /auto-down`?\s*(?:=\s*)?`?(?:off|aus)`?,\s*der (?:Standard|Default)\b/ },
  { pattern: /\bper Default aus\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bauf dem Default `?off\b/ },
  { pattern: /\baus ausgeliefert\b/, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bausgelieferte[nm]? `?false\b/, alongside: /auto-?down|abgestürzt|Failure Detector/i },
  { pattern: /\bPer Default parkt\b/i },
  { pattern: /\bparkt auch der Default\b/ },
  { pattern: /\bvom Default ohne Strategie\b/ },
  {
    pattern:
      /\b(?:im|der|dem) Default\b(?:(?!Opt-out|auto-down`?\s*=\s*`?off|Strategie)[\s\S])*?\b(?:entfernt|evakuiert)\b(?:(?!Opt-out|auto-down`?\s*=\s*`?off|Strategie)[\s\S])*?\b(?:nichts|niemanden)\b/,
  },
  { pattern: /\bStandard(?:mäßig)?\b.{0,40}?\bentfernt\b.{0,40}?\b(?:nichts|niemanden)\b/ },
  { pattern: /\bStandard ist also manuell\b/ },
  { pattern: /\bOpt-in\b/, alongside: ABOUT_AUTO_DOWN },
  { pattern: /auto-down = on`? (?:wählt|stellt)\b/ },
  { pattern: /\bentfernt nichts (?:ein|einen)\b/ },
  { pattern: /\bOhne (?:Downing|Strategie)\w*\b[\s\S]*?\bparkt\b/, unless: QUALIFIED },
  { pattern: /\bDetector\b.{0,20}?\bparkt\b.{0,40}?\bnur\b/, unless: QUALIFIED },
  { pattern: /\bWeg aus dem Default\b/ },
  {
    pattern: /\b(?:der|dem|im) Default\b[^.]*?\bkein (?:Knotenverlust-)?`?Terminated\b/,
    alongside: /\bNodes?\b/,
    unless: QUALIFIED,
  },
  { pattern: /`off` ist der Default\b/ },
  { pattern: /\bstandardmäßig (?:aus|`?off`?|`?false`?)\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bPer Default wird\b[^.]{0,80}?\bgeparkt\b/ },
  { pattern: /\bPer Default\b[\s\S]{0,80}?auto-down`?\s*=\s*`?off\b/, unless: /\bOpt-out\b/ },
  { pattern: /\b[Nn]eben einer (?:konfigurierten )?Strategie\b[^.]{0,40}\babgelehnt\b/ },
  { pattern: /\bbis es wieder Heartbeats\s+schickt\b/ },
  { pattern: /\bwenn Heartbeats\s+wieder ankommen\b/ },
];

/**
 * Every page and example comment that discusses what becomes of a crashed
 * peer.  Listed rather than globbed: a page that states the default joins by
 * being listed, and one whose wording another change owns is not held here
 * before that change lands.
 */
const GUARDED_FILES: readonly string[] = [
  ...LANGUAGES.flatMap((language) => [
    page(language, 'cluster/failure-detector.mdx'),
    page(language, 'cluster/downing-strategies.mdx'),
    page(language, 'operations/security/cluster-security.mdx'),
    page(language, 'cluster/overview.mdx'),
    page(language, 'reference/faq.mdx'),
    page(language, 'cluster/weakly-up.mdx'),
    page(language, 'coordination/overview.mdx'),
    page(language, 'fundamentals/death-watch.mdx'),
    page(language, 'observability/management/http-endpoints.mdx'),
    page(language, 'operations/troubleshooting.mdx'),
    page(language, 'operations/tuning/failure-detector.mdx'),
    page(language, 'reference/configuration.mdx'),
    page(language, 'testing/multi-node-spec.mdx'),
    page(language, 'testing/parallel-multi-node.mdx'),
    page(language, 'cluster/joining-and-seeds.mdx'),
    page(language, 'cluster/cluster-bootstrap.mdx'),
    page(language, 'observability/management/health-checks.mdx'),
  ]),
  // The examples that configure keep-majority say why in a comment, and the
  // reason they gave was the parking default.
  'examples/chat/application.conf',
  'examples/chat/backend/main.ts',
  'examples/voice/application.conf',
  'examples/voice/backend/main.ts',
  'examples/cluster/counter-node.ts',
];

/** Prose cut into sentences after a terminal mark followed by whitespace. */
function proseSentences(lines: readonly string[]): string[] {
  return lines
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence !== '');
}

/**
 * The units a phrasing is looked for in, as a reader meets them.  On a page,
 * prose is cut into sentences — after a terminal mark followed by whitespace,
 * so the dots in `failure-detector.auto-down` stay inside their sentence — and
 * each line of a code fence is a unit of its own, because a sample's lines do
 * not run on into each other.  In an example, comment markers are dropped so a
 * comment reads as the prose it is.
 */
function unitsOf(path: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (!path.endsWith('.mdx')) {
    return proseSentences(lines.map((line) => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#)\s?/, '')));
  }
  const units: string[] = [];
  let prose: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) units.push(...proseSentences(prose));
      prose = [];
      inFence = !inFence;
    } else if (inFence) {
      units.push(line.trim());
    } else {
      prose.push(line);
    }
  }
  units.push(...proseSentences(prose));
  return units.filter((unit) => unit !== '');
}

describe('#1426 — no page or example says the detector parks by default', () => {
  test('none of the phrasings the parking default was written in is back', () => {
    // The list below is written for the removal default.  If the bundled file
    // ships `auto-down = off` again, the sentences it refuses are the right
    // ones, and it is the list that has to be rewritten, not the pages.
    expect(
      SHIPPED_AUTO_DOWN,
      `reference.conf ships ${AUTO_DOWN} = off, and this phrase list refuses exactly the sentences `
      + 'that describe that default.  Rewrite the list for the shipped value before trusting it.',
    ).toBe(true);
    const found: string[] = [];
    for (const path of GUARDED_FILES) {
      for (const sentence of unitsOf(path, read(path))) {
        const phrasing = OLD_PHRASINGS.find(
          (old) => old.pattern.test(sentence)
            && (old.alongside === undefined || old.alongside.test(sentence))
            && (old.unless === undefined || !old.unless.test(sentence)),
        );
        if (phrasing !== undefined) found.push(`  ${path}:\n      ${sentence}\n      matched ${phrasing.pattern}`);
      }
    }
    expect(
      found,
      `${found.length} sentence(s) describe parking as the default or the detector's removal as an opt-in:\n`
      + `${found.join('\n')}\n`
      + 'With no strategy configured the detector removes a peer silent past down-after — '
      + '`failure-detector.auto-down = on` is the default, and `off` is the opt-out that parks it.',
    ).toEqual([]);
  });
});

/**
 * The readiness page says which peers `cluster-transport` still expects.
 *
 * A peer parked past `down-after` under `auto-down = off` with no downing
 * strategy is not one of them (`expectedPeers` in
 * `src/cluster/ClusterHealthChecks.ts`), so the survivor of a crash is ready
 * again at `down-after` under the opt-out exactly as under the default.  A
 * reader who believed the opposite would hold a parked survivor out of the
 * load balancer for good, or keep it there with a probe of their own.
 *
 * The exception is narrow, and the page has to keep it narrow: a peer that is
 * only `unreachable`, short of `down-after`, still counts, and so does a peer
 * a configured downing provider is holding — only the no-provider opt-out
 * parks into the set `expectedPeers` subtracts.  Keyed on markers within one
 * sentence each, like the rest of this file: a sentence that defines the
 * expected peers *and* excepts the parked one; one that says the survivor is
 * ready again at `down-after` — not "not ready again"; one that keeps a peer
 * short of `down-after` counted; and no sentence that claims the opposite of
 * the code for a parked peer or for one a strategy holds.
 */
type ExpectedPeersText = {
  readonly path: string;
  readonly section: string;
  readonly definition: readonly RegExp[];
  readonly readyAgain: RegExp;
  readonly stillCounts: readonly RegExp[];
  readonly contradictions: readonly RegExp[];
};

const EXPECTED_PEERS_TEXTS: readonly ExpectedPeersText[] = [
  {
    path: page(LANGUAGES[0]!, 'observability/management/health-checks.mdx'),
    section: '## The built-in checks',
    definition: [/\bexpects?\b/i, /\bexcept\b/i, /\bparked\b/i, /`down-after`/, /auto-down/],
    readyAgain: /(?<!\b(?:not|never|no longer) )\bready again at `down-after`/i,
    stillCounts: [/\bnot yet past `down-after`/i, /\bstill counts\b/i],
    contradictions: [
      /\bparked\b[^.]*?\b(?:stays|remains|is still|still) (?:expected|counted)\b/i,
      /\bstrateg\w*\b[^.]*?\b(?:is |are )?(?:not|no longer) (?:expected|counted)\b/i,
    ],
  },
  {
    path: page(LANGUAGES[1]!, 'observability/management/health-checks.mdx'),
    section: '## Die eingebauten Checks',
    definition: [/\berwartet\b/, /\bAusnahme\b/, /\bgeparkt\b/, /`down-after`/, /auto-down/],
    readyAgain: /\bbei `down-after` wieder bereit\b/,
    stillCounts: [/`down-after`\s+noch nicht erreicht/, /\bzählt weiterhin\b/],
    contradictions: [
      /\bgeparkt\w*\b[^.]*?\b(?:bleibt|wird weiterhin|weiterhin) (?:erwartet|gezählt)\b/,
      /\bStrategie\b[^.]*?\b(?:nicht|nicht mehr) (?:erwartet|gezählt)\b/,
    ],
  },
];

/** The prose of the `## ` section headed exactly `heading`, as sentences. */
function sectionSentences(path: string, heading: string): string[] {
  const lines = read(path).split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`${path}: the heading "${heading}" is gone — re-point this guard.`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return unitsOf(path, lines.slice(start + 1, next < 0 ? undefined : next).join('\n'));
}

describe('#1426 — the readiness page says a parked peer is not an expected peer', () => {
  for (const text of EXPECTED_PEERS_TEXTS) {
    test(`${text.path}: cluster-transport does not wait for a peer parked past down-after`, () => {
      const sentences = sectionSentences(text.path, text.section);
      expect(
        sentences.some((sentence) => text.definition.every((marker) => marker.test(sentence))),
        `${text.path}: no sentence in "${text.section}" defines the peers cluster-transport still expects `
        + 'and excepts one parked past down-after under failure-detector.auto-down = off with no strategy. '
        + 'expectedPeers in src/cluster/ClusterHealthChecks.ts leaves such a peer out.',
      ).toBe(true);
      expect(
        sentences.some((sentence) => text.readyAgain.test(sentence)),
        `${text.path}: no sentence in "${text.section}" says the survivor of a crash is ready again at `
        + 'down-after — under the opt-out it parks the dead peer then and stops expecting it.',
      ).toBe(true);
      expect(
        sentences.some((sentence) => text.stillCounts.every((marker) => marker.test(sentence))),
        `${text.path}: no sentence in "${text.section}" says that a peer unreachable short of down-after `
        + 'still counts — the exception is the parked peer only, and a short blip still takes a lone '
        + 'survivor out of rotation.',
      ).toBe(true);
      const contradicting = sentences.filter((sentence) => text.contradictions.some((pattern) => pattern.test(sentence)));
      expect(
        contradicting,
        `${text.path}: ${contradicting.length} sentence(s) in "${text.section}" contradict expectedPeers: a `
        + 'parked peer is not expected, and a peer a configured strategy is holding still is.',
      ).toEqual([]);
    });
  }
});
