/**
 * The two shapes of secret that the URL redaction's line rule gives up, held
 * to the page that states them (#1458).
 *
 * A userinfo ends on its own line, so that the next frame of a stack or the
 * next line of a log is never read as a password.  The same rule masks two
 * shapes less than v0.17.0 did — a space or a tab after a line break, in front
 * of the `@`, and an `@` in front of a line break with more of the secret
 * behind it — and that trade was accepted.  `reference/utility-helpers.mdx`
 * says what comes back for each, in English and in German, and what the label
 * does with them, since they are the exception to its promise against the
 * v0.17.0 label.
 *
 * Every output the page quotes is computed here from the function rather than
 * kept as a second copy of the words, so a change to the scan that the page
 * does not follow turns this red, and so does a page that goes back to saying
 * the two are masked whole.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { redactedUrlLabel, redactUrlCredentials } from '../../../src/util/RedactUrlCredentials.js';
import { releasedRedactedUrlLabel } from '../util/RedactedUrlLabelV0170.fixture.js';

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/**
 * The prose of one section of a page, from its heading to the next `## `
 * heading.  MDX comments and code fences are cut first — a sentence that lives
 * only in one of them is not said in the prose — and every run of whitespace
 * is folded to one space, so rewrapping a paragraph moves no pin.
 */
function sectionProse(relative: string, heading: string): string {
  const text = readFileSync(join(DOCS_ROOT, relative), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gm, '');
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`${relative} has no heading "${heading}"`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
}

/** A value the way the page quotes it: a single-quoted JavaScript string in a code span, line breaks escaped. */
function quoted(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `\`'${escaped}'\``;
}

/** A space after the line break, in front of the `@`: the scan stops before it reaches one. */
const SPACE_AFTER_BREAK = 'amqp://user:pa\n ss@rabbit';
/** An `@` in front of the line break, and more of the secret behind it: the userinfo ends at the break. */
const AT_BEFORE_BREAK = 'amqp://user:p@ss\nword@rabbit';
/** The first shape in an entry of a list, which the label masks rather than parses. */
const IN_A_LIST = 'nats://a:b@h1,nats://u:pa\n ss@h2';

type Page = {
  readonly path: string;
  readonly heading: string;
  /** The clause that says `input` comes back as it went in. */
  readonly unchanged: (input: string) => string;
  /** The clause that says `input` comes back as `output`. */
  readonly becomes: (input: string, output: string) => string;
  /** The label's promise against the v0.17.0 label, with the two shapes taken out of it. */
  readonly labelPromise: string;
  /** The same promise without that exception — what the page said before, which these shapes make false. */
  readonly unqualifiedLabelPromise: string;
};

const PAGES: readonly Page[] = [
  {
    path: 'reference/utility-helpers.mdx',
    heading: '## Logging a URL without logging the password',
    unchanged: (input) => `${quoted(input)} comes back unchanged`,
    becomes: (input, output) => `${quoted(input)} comes back as ${quoted(output)}`,
    labelPromise: 'but for the two multi-line shapes above, shows no credential that the v0.17.0 label kept out',
    unqualifiedLabelPromise: 'and shows no credential that the v0.17.0 label kept out',
  },
  {
    path: 'de/reference/utility-helpers.mdx',
    heading: '## Eine URL loggen, ohne das Passwort zu loggen',
    unchanged: (input) => `kommt ${quoted(input)} unverändert zurück`,
    becomes: (input, output) => `kommt ${quoted(input)} als ${quoted(output)} zurück`,
    labelPromise: 'außer bei den beiden mehrzeiligen Formen oben, kein Credential, das das Label von v0.17.0 verborgen hat',
    unqualifiedLabelPromise: 'und zeigt kein Credential, das das Label von v0.17.0 verborgen hat',
  },
];

describe('the line rule gives two multi-line shapes up, and the page says what comes back (#1458)', () => {
  test('a space or a tab after a line break ends the scan before the "@", so nothing is masked', () => {
    expect(redactUrlCredentials(SPACE_AFTER_BREAK)).toBe(SPACE_AFTER_BREAK);
    const tabbed = SPACE_AFTER_BREAK.replace(' ', '\t');
    expect(redactUrlCredentials(tabbed)).toBe(tabbed);
  });

  test('an "@" in front of a line break ends the userinfo there, so the rest of the secret stays', () => {
    const output = redactUrlCredentials(AT_BEFORE_BREAK);
    expect(output).not.toContain('user:p');
    expect(output).toContain('ss\nword@rabbit');
  });

  for (const page of PAGES) {
    test(`${page.path} quotes what the scan returns for both`, () => {
      const prose = sectionProse(page.path, page.heading);
      for (const input of [SPACE_AFTER_BREAK, AT_BEFORE_BREAK]) {
        const output = redactUrlCredentials(input);
        expect(prose).toContain(output === input ? page.unchanged(input) : page.becomes(input, output));
      }
    });
  }
});

describe('the label hides the two shapes only where it rebuilds the value from its parse (#1458)', () => {
  test('one URL is rebuilt from its parse, and both are hidden', () => {
    expect(redactedUrlLabel(SPACE_AFTER_BREAK)).toBe('amqp://rabbit');
    expect(redactedUrlLabel(AT_BEFORE_BREAK)).toBe('amqp://rabbit');
  });

  test('a list shows the entry the way the scan does, where the v0.17.0 label hid it', () => {
    expect(redactedUrlLabel(IN_A_LIST)).toBe(redactUrlCredentials(IN_A_LIST));
    expect(redactedUrlLabel(IN_A_LIST)).toContain('u:pa\n ss@h2');
    // The exception the page's promise needs: the release kept this entry out.
    expect(releasedRedactedUrlLabel(IN_A_LIST)).not.toContain('pa\n ss');
  });

  for (const page of PAGES) {
    test(`${page.path} quotes the list case and takes the two shapes out of the label's promise`, () => {
      const prose = sectionProse(page.path, page.heading);
      expect(prose).toContain(page.becomes(IN_A_LIST, redactedUrlLabel(IN_A_LIST)));
      expect(prose).toContain(page.labelPromise);
      expect(prose).not.toContain(page.unqualifiedLabelPromise);
    });
  }
});
