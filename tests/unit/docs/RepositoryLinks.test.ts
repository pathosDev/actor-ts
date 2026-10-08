import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **Every link into this repository names the account it lives under.**
 *
 * Twenty-two links on eleven page pairs sent readers to
 * `github.com/mknorr/actor-ts/issues/792` and `…/issues/960`, a repository
 * that does not exist: GitHub answers 404.  Both issues live under
 * `pathosDev`, the origin remote, which is what every other link in the
 * documentation already said.  Fourteen of them came in with the three
 * commits that first linked those issues; a fourth then copied the aside
 * they sat in onto eight more journal pages.  A link is copied far more often
 * than anybody clicks it, and nothing that builds the site follows one
 * (found while #1430).
 *
 * ## Why the owner is a constant
 *
 * The owner is the repository's origin remote, but this guard does not ask
 * git for it.  `git remote get-url origin` answers for whichever clone the
 * test runs in: a fork's origin names the fork, a CI checkout's is whatever
 * the checkout step configured, and an unpacked tarball has no remote at
 * all.  The links mean the canonical repository wherever they are read, so
 * its owner is a fact of the source tree, pinned once below and held against
 * the `repository` field of `package.json`, the other place the tree states
 * it.  Moving the repository is an edit to that constant and a sweep of the
 * links, in one commit.
 *
 * ## What counts as a link
 *
 * Any address that names `<owner>/actor-ts` on `github.com` (with or without
 * a scheme or `www.`) or on `raw.githubusercontent.com`, anywhere in the
 * text: an MDX or Markdown inline link, a reference definition, an autolink,
 * a bare URL, a JSX `href`, a frontmatter value, a fenced `git clone` line,
 * even a comment.  The scan reads raw text instead of parsing Markdown on
 * purpose: a parser that knows the link syntaxes is one that can miss one,
 * and each of those places takes a reader to the same address.  Host, owner
 * and repository name compare case-insensitively because GitHub resolves
 * them that way, so `pathosdev` is the same account.  An owner that is not a
 * plain name, `${owner}` in a template literal or a `<you>` placeholder,
 * fails too: the guard cannot tell where it leads, and no page needs one.
 *
 * What is read: every file of the content tree whatever its extension
 * (Starlight's loader renders five Markdown extensions besides `.md` and
 * `.mdx`, so a renamed copy is still a page), the root `*.md` files, and the
 * site configuration, whose `editLink` puts the owner into the "Edit page"
 * link of every page.  The generated `api/` tree is skipped: TypeDoc writes
 * it on every build with source links taken from the building clone's own
 * `origin`, which is exactly the dependency this guard declines, and it is
 * gitignored.
 *
 * ## Why a test rather than a link checker
 *
 * A link checker needs the network, which a unit test may not depend on, and
 * it would pass on the day somebody forks the repository under the wrong
 * name: the link would resolve, to the fork.  Reading 500 files for one
 * pattern costs milliseconds and answers the question that matters here,
 * which is not "does it resolve" but "is it ours".
 */

/** The account the repository lives under; the header says why this is not read from git. */
const REPOSITORY_OWNER = 'pathosDev';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const CONTENT_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');
const CONTENT_PREFIX = 'docs/src/content/docs/';
const SITE_CONFIGURATION = 'docs/astro.config.mjs';

/** TypeDoc's generated tree — present after a local build, absent in a clone. */
const GENERATED_DIRECTORY = 'api';

/**
 * A GitHub address of a repository named `actor-ts`; the capture is the owner,
 * which is whatever stands between the host and `/actor-ts`, so a placeholder
 * or an interpolation is captured as itself rather than skipped.  The host
 * may not be the tail of a longer name (`notgithub.com`), and the repository
 * name may not run on (`actor-ts-extras` is somebody else's repository),
 * while `actor-ts.git` is still this one.
 */
const REPOSITORY_ADDRESS = /(?<![A-Za-z0-9-])(?:github\.com|raw\.githubusercontent\.com)\/([^/\s]+)\/actor-ts(?![A-Za-z0-9_-])/gi;

type RepositoryAddress = {
  readonly line: number;
  readonly owner: string;
  readonly address: string;
};

type FoundAddress = RepositoryAddress & {
  readonly path: string;
};

/** Every repository address in `text`, with the 1-based line it starts on. */
function repositoryAddresses(text: string): readonly RepositoryAddress[] {
  return [...text.matchAll(REPOSITORY_ADDRESS)].map((match) => ({
    line: text.slice(0, match.index).split('\n').length,
    owner: match[1]!,
    address: match[0],
  }));
}

function namesTheOwner(address: RepositoryAddress): boolean {
  return address.owner.toLowerCase() === REPOSITORY_OWNER.toLowerCase();
}

function contentFiles(directory: string, prefix = ''): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (prefix === '' && entry.name === GENERATED_DIRECTORY) continue;
      found.push(...contentFiles(join(directory, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.isFile()) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

const contentPages = contentFiles(CONTENT_ROOT);
const rootDocuments = readdirSync(REPOSITORY_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name);

const sources: ReadonlyArray<{ readonly path: string; readonly text: string }> = [
  ...contentPages.map((page) => ({ path: `${CONTENT_PREFIX}${page}`, text: readFileSync(join(CONTENT_ROOT, page), 'utf8') })),
  ...rootDocuments.map((name) => ({ path: name, text: readFileSync(join(REPOSITORY_ROOT, name), 'utf8') })),
  { path: SITE_CONFIGURATION, text: readFileSync(join(REPOSITORY_ROOT, SITE_CONFIGURATION), 'utf8') },
];

const found: readonly FoundAddress[] = sources.flatMap(({ path, text }) =>
  repositoryAddresses(text).map((address) => ({ path, ...address })),
);

/**
 * One foreign owner in each place a page can carry a link, with the line it
 * must be reported on.  The first is the shape that shipped twenty-two times.
 */
const FOREIGN_OWNER_SHAPES: ReadonlyArray<readonly [shape: string, document: string, line: number]> = [
  ['an MDX inline link', 'aside text\n  ([#960](https://github.com/mknorr/actor-ts/issues/960)).\n', 2],
  ['a bare URL in prose', 'Filed as https://github.com/someone-else/actor-ts/issues/1 last week.\n', 1],
  ['a Markdown reference definition', 'See [#960][issue].\n\n[issue]: https://github.com/someone-else/actor-ts/issues/960\n', 3],
  ['an autolink', 'Source: <https://github.com/someone-else/actor-ts>\n', 1],
  ['a JSX href', '<LinkCard title="Examples" href="https://github.com/someone-else/actor-ts/tree/main/examples" />\n', 1],
  ['a frontmatter value', '---\nhero:\n  actions:\n    - link: https://github.com/someone-else/actor-ts\n---\n', 4],
  ['a fenced git clone line', '```sh\ngit clone https://github.com/someone-else/actor-ts.git\n```\n', 2],
  ['an MDX comment, which renders nothing', '{/* https://github.com/someone-else/actor-ts */}\n', 1],
  ['an HTML comment', '<!-- see https://github.com/someone-else/actor-ts -->\n', 1],
  ['a raw file link', '![diagram](https://raw.githubusercontent.com/someone-else/actor-ts/main/docs/x.png)\n', 1],
  ['no scheme, www and every name in another case', 'at WWW.GitHub.com/SomeOne-Else/Actor-TS/issues\n', 1],
  ['plain http', 'http://github.com/someone-else/actor-ts\n', 1],
  ['an owner that only begins with the right one', 'https://github.com/pathosDevelopment/actor-ts\n', 1],
  ['a template literal whose owner nobody can read off the page', 'href={`https://github.com/${owner}/actor-ts`}\n', 1],
  ['CRLF line endings', 'one\r\ntwo\r\n[x](https://github.com/someone-else/actor-ts)\r\n', 3],
  ['a correct link earlier on the same line', '[a](https://github.com/pathosDev/actor-ts/issues/1), [b](https://github.com/someone-else/actor-ts/issues/2)\n', 1],
];

/** Addresses the scanner must leave alone, with how many of them name the owner. */
const NOT_FOREIGN: ReadonlyArray<readonly [shape: string, document: string, ownersLinks: number]> = [
  ['the owner itself', '([#960](https://github.com/pathosDev/actor-ts/issues/960))', 1],
  ['the owner in another case, which GitHub resolves to the same account', 'https://github.com/pathosdev/actor-ts and HTTPS://GITHUB.COM/PATHOSDEV/ACTOR-TS', 2],
  ['the clone URL', 'git clone https://github.com/pathosDev/actor-ts.git', 1],
  ['the raw host', 'https://raw.githubusercontent.com/pathosDev/actor-ts/main/x.png', 1],
  ['another owner\'s other repository', 'https://github.com/gvergnaud/ts-pattern', 0],
  ['a repository whose name only begins with actor-ts', 'https://github.com/someone-else/actor-ts-extras', 0],
  ['a host whose name only ends in github.com', 'https://notgithub.com/someone-else/actor-ts', 0],
];

describe('links into this repository name its owner', () => {
  test('the scanner flags a foreign owner in every place a page can carry a link', () => {
    for (const [shape, document, line] of FOREIGN_OWNER_SHAPES) {
      const foreign = repositoryAddresses(document).filter((address) => !namesTheOwner(address));
      expect(foreign.map((address) => address.line), shape).toEqual([line]);
    }
  });

  test('the scanner leaves the owner alone, in any case, and other repositories too', () => {
    for (const [shape, document, ownersLinks] of NOT_FOREIGN) {
      const addresses = repositoryAddresses(document);
      expect(addresses.filter((address) => !namesTheOwner(address)), shape).toEqual([]);
      expect(addresses.filter(namesTheOwner).length, shape).toBe(ownersLinks);
    }
  });

  test('the walk reads every file of the content tree, whatever its extension, and skips only the generated tree at its top', () => {
    // A fixture root rather than the real tree: the generated directory is
    // absent from every clone, and the real tree holds only `.md` and `.mdx`
    // today, so neither half could fail against it.
    const root = mkdtempSync(join(tmpdir(), 'repository-links-'));
    try {
      for (const file of ['index.mdx', 'guide.markdown', 'notes/stub.mdown', 'api/generated.md', 'de/api/handwritten.md']) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), '# page\n');
      }
      expect([...contentFiles(root)].sort()).toEqual(['de/api/handwritten.md', 'guide.markdown', 'index.mdx', 'notes/stub.mdown']);
    } finally {
      if (root !== '') rmSync(root, { recursive: true, force: true });
    }
  });

  test('the owner constant is the repository the package manifest names', () => {
    const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      readonly repository: { readonly url: string };
    };
    expect(repositoryAddresses(manifest.repository.url).map((address) => address.owner)).toEqual([REPOSITORY_OWNER]);
  });

  test('the scan read both languages, the root files and the site configuration, and found the owner\'s links in each', () => {
    // Guards the guard: a wrong root, a walk that stops early or a pattern
    // that matches nothing would pass the last test by finding nothing to
    // object to.  The owner's own links — 170 when this was written — are
    // the proof that the scan reaches the places a foreign one would sit.
    expect(contentPages.length).toBeGreaterThan(400);
    expect(contentPages.filter((page) => page.startsWith('de/')).length).toBeGreaterThan(200);
    expect(rootDocuments).toEqual(expect.arrayContaining(['README.md', 'CHANGELOG.md', 'SECURITY.md']));
    const owners = found.filter(namesTheOwner);
    expect(owners.length).toBeGreaterThan(100);
    const english = owners.filter(({ path }) => path.startsWith(CONTENT_PREFIX) && !path.startsWith(`${CONTENT_PREFIX}de/`));
    const german = owners.filter(({ path }) => path.startsWith(`${CONTENT_PREFIX}de/`));
    expect(english.length, 'English pages').toBeGreaterThan(0);
    expect(german.length, 'German pages').toBeGreaterThan(0);
    expect(owners.filter(({ path }) => rootDocuments.includes(path)).length, 'root files').toBeGreaterThan(0);
    expect(owners.filter(({ path }) => path === SITE_CONFIGURATION).length, 'site configuration').toBeGreaterThan(0);
  });

  test('no page, root file or site setting links the repository under another owner', () => {
    const foreign = found.filter((address) => !namesTheOwner(address));
    const report = foreign
      .map(({ path, line, address }) => `  ${path}:${line}: ${address}`)
      .join('\n');
    expect(
      foreign,
      `${foreign.length} link(s) address actor-ts under an owner other than ${REPOSITORY_OWNER}, which is a `
      + `different repository or none at all. Point them at github.com/${REPOSITORY_OWNER}/actor-ts:\n${report}`,
    ).toEqual([]);
  });
});
