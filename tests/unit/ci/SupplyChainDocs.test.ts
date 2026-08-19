import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Repo-file guard over the supply-chain page, in the same family as
 * `tests/unit/ci/SecurityPolicy.test.ts` and
 * `tests/unit/ci/WorkflowHygiene.test.ts`: assertions about files no compiler
 * reads and no `bun test` would otherwise open.
 *
 * The reason this page needs one is a defect it shipped with (#539). The SBOM
 * jobs were added to `publish.yml` roughly five hours *after* the v0.16.0
 * publish run had already finished, so they have never executed and
 * `gh release view v0.16.0 --json assets` answers with an empty list — while
 * the page told the reader to run
 * `gh release download v0.16.0 --pattern 'actor-ts-sbom.cyclonedx.json'`.
 * Prose that documents a pipeline can be wrong in a way code cannot: it went
 * through review, typechecked (it is not code), and every gate stayed green,
 * because nothing in the toolchain compares a documented command against the
 * repository state it describes.
 *
 * Hence the two invariants below, chosen so that neither can be satisfied by
 * restating the sentence that was wrong:
 *
 * 1. **A documented download command never names a concrete release tag.**
 *    Not merely "not v0.16.0" — *any* hard-coded tag is wrong here. Every
 *    release that exists today predates the jobs, and a tag pinned in prose
 *    rots at the next release even once one of them does carry the asset. A
 *    `vX.Y.Z` placeholder cannot go stale.
 * 2. **The claim stays qualified.** The page may not promise the SBOM as an
 *    unconditional property of a release the reader can already download.
 *
 * A third assertion ties the documented `--pattern` to the filename
 * `publish.yml` actually produces, so renaming the asset in the workflow
 * cannot silently leave the documented command matching nothing.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

const SUPPLY_CHAIN_PATH = join('operations', 'security', 'supply-chain.mdx');

const englishPage = readFileSync(join(DOCUMENTATION_ROOT, SUPPLY_CHAIN_PATH), 'utf8');

const germanPage = readFileSync(join(DOCUMENTATION_ROOT, 'de', SUPPLY_CHAIN_PATH), 'utf8');

const publishWorkflow = readFileSync(
  join(REPOSITORY_ROOT, '.github', 'workflows', 'publish.yml'),
  'utf8',
);

/** The asset name `anchore/sbom-action` is told to emit, read out of the workflow. */
const sbomAssetName: string =
  /output-file:\s*(\S+)/.exec(publishWorkflow)?.[1] ?? '';

/** A concrete release tag: `v0.16.0`. The `vX.Y.Z` placeholder deliberately does not match. */
const concreteReleaseTag = /\bv\d+\.\d+\.\d+\b/;

const pages: readonly (readonly [string, string])[] = [
  ['English', englishPage],
  ['German', germanPage],
];

/**
 * Only the lines a reader copies. The surrounding prose names v0.16.0 on
 * purpose — as the release that carries *no* asset — so a page-wide search for
 * a version tag would flag the very sentence that makes the page correct.
 */
const downloadCommands = (page: string): readonly string[] =>
  page.split('\n').filter((line) => line.includes('gh release download'));

describe('supply-chain documentation', () => {
  test('the workflow still declares the asset the page tells readers to fetch', () => {
    // Guards the guard: an empty asset name would make the two assertions
    // below compare against nothing and pass.
    expect(
      sbomAssetName,
      'publish.yml no longer declares an `output-file:` for the SBOM, so this '
      + 'file can no longer tell whether the documented --pattern matches what '
      + 'the release actually carries.',
    ).toMatch(/\.cyclonedx\.json$/);

    for (const [language, page] of pages) {
      expect(
        page,
        `The ${language} supply-chain page documents a --pattern that no longer `
        + `matches the asset publish.yml produces (${sbomAssetName}). Renaming `
        + 'the asset in the workflow has to move the documented command with it, '
        + 'or the command silently downloads nothing.',
      ).toContain(sbomAssetName);
    }
  });

  test('no documented download command names a concrete release tag', () => {
    for (const [language, page] of pages) {
      const commands = downloadCommands(page);

      // Guards the guard: a page that stopped showing the command at all would
      // vacuously satisfy the loop below.
      expect(
        commands.length,
        `The ${language} supply-chain page no longer shows a \`gh release `
        + 'download\` command, so this test would pass without asserting '
        + 'anything. Restore the example or delete this assertion deliberately.',
      ).toBeGreaterThan(0);

      for (const command of commands) {
        expect(
          command,
          `The ${language} supply-chain page hard-codes a release tag in a `
          + `download command: "${command.trim()}". Every release up to and `
          + 'including v0.16.0 predates the SBOM jobs in publish.yml and carries '
          + 'no asset, so a concrete tag hands the reader a command that fails — '
          + 'and even once a release does carry it, a tag pinned in prose is '
          + 'stale at the following release. Use the vX.Y.Z placeholder.',
        ).not.toMatch(concreteReleaseTag);
      }
    }
  });

  /**
   * The wording is asserted per language because the pages are translations,
   * not copies. Both anchors are the sentence that carries the qualification,
   * so losing the qualification is what turns this red — restating the claim
   * in other words would not satisfy it.
   */
  test('the SBOM claim stays qualified in both languages', () => {
    expect(
      englishPage,
      'The English page promises the SBOM "on every release" again. No '
      + 'published release carries it: the jobs landed after v0.16.0 shipped.',
    ).not.toMatch(/SBOM on every release/i);
    expect(englishPage).toContain('from the next release onward');

    expect(
      germanPage,
      'Die deutsche Seite verspricht die SBOM wieder "an jedem Release". Kein '
      + 'veröffentlichtes Release trägt sie: die Jobs sind nach v0.16.0 gelandet.',
    ).not.toMatch(/SBOM an jedem Release/i);
    expect(germanPage).toContain('ab dem nächsten Release');
  });
});
