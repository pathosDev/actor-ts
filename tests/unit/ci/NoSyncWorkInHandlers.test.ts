import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **A ratchet over blocking `*Sync` calls in `src/` and `examples/` (#1540).**
 *
 * An actor system on Bun, Node or Deno runs on one thread.  A handler that
 * calls `gzipSync` on a 24 MiB body holds that thread for the whole encode,
 * and the blast radius is not the actor but the process: every mailbox waits,
 * and the p99 of actors that had nothing to do with the write carries the
 * cost.  `Compression.ts` did exactly that — sync zlib inside `async` arrows,
 * promise-shaped from the outside, and every compression test green because
 * the bytes came back right.  The chat example's login did it four times per
 * frame with `scryptSync`.  Both are fixed; this file is what keeps them
 * fixed, and what makes the next one cost a review.
 *
 * Work that computes belongs in one of three tiers, and the first is the one
 * this ratchet points at: **(1)** the runtime's own async forms, which run on
 * its thread pool — `zlib.gzip` not `gzipSync`, `crypto.scrypt` not
 * `scryptSync`, `fs.promises.*`; **(2)** a worker thread through the
 * `OffloadPool` for pure-JS CPU work, or for compression on Deno, whose async
 * zlib defers the call and then blocks on it; **(3)** a native addon that
 * brings its own threads.  `docs/…/fundamentals/blocking-and-cpu-bound-work.mdx`
 * is the long form.
 *
 * ## What is counted
 *
 * A **closed list** of Node built-in names, in **mention position** — an
 * import specifier, a type-literal member, a property read, a call all count,
 * and they are called "mentions" everywhere below for that reason.  Deleting
 * the last call deletes its import too, so the ratchet still only ever moves
 * down; and it is aliased reads that a call-shaped regex misses: every zstd
 * call in the old `Compression.ts` went through a local (`bunCompress`,
 * `compressFunction`), so `Sync\(` never saw one.  The issue's own
 * call-shaped regex, run over the pre-fix tree, found 15 hits of which 9 were
 * comments and type lines — which is why the scanner blanks comments and
 * strings before it counts, and counts mentions rather than calls.
 *
 * The list is closed on purpose.  A generic `\w+Sync` in code position finds
 * exactly four names off it today (measured at {@link LEDGER_REVISION}):
 * `ClusterSingletonManager.reconcileSync` ×5 (a method name, not a blocking
 * call), `Lazy.getSync` ×1 (a memo accessor), `mkdtempSync` ×3 (temp
 * directories in two examples' set-up), and node:sqlite's `DatabaseSync` ×3 —
 * which is **synchronous by design**: the SQLite journal's documented
 * trade-off is that a local in-process database answers in microseconds and
 * a thread hop would cost more than the query.  None of those is what this
 * file is about.  `load` is on the list for `@grpc/proto-loader`'s
 * `loadSync`; `mkdtemp` is not, a temp directory is set-up.
 *
 * ## Per-site entries, no directory exemptions
 *
 * A file may mention a listed name fewer times than the ledger records, never
 * more, and a file the ledger does not name may not mention one at all.  There
 * is no `src/config/` or `src/runtime/` exclusion: a new `gzipSync` under
 * `src/config/` has to be red, and the reads that legitimately live there —
 * the HOCON chain at startup, the worker bootstrap's module lookup — are
 * ledgered one by one with the reason beside them.  Same for TLS material
 * read once at config time and the DevTools identity-encoding fallback, which
 * stay synchronous by decision, not by oversight (#1540).
 *
 * `examples/` is in scope because the examples are what people copy, and
 * because it is the only thing that binds the chat conversion: the chat
 * smoke test prints `chat smoke test passed` on the sync tree too.
 *
 * It is a ratchet, not an adversary.  `zlib['gzipSync']`, a `require` through
 * a computed name or a re-export under another name all evade it, and that
 * is fine — the point is that the ordinary way to write one stops being free.
 * Same shape as the sibling ratchets over wall-clock reads
 * (`WallClockRatchet.test.ts`) and fixed sleeps (`SleepRatchet.test.ts`).
 *
 * ## Lowering an entry
 *
 * Ordinary work: move to the async form (tier 1), or to the pool (tier 2),
 * and drop the count.  Deleting an entry that has reached zero is the end
 * state.
 *
 * ## Raising one, or adding one
 *
 * Needs a reason written beside it, and the reason has to say why the call
 * cannot be inside an actor's turn: it runs at startup before any actor
 * exists, once per process and cached, in a test harness, or at teardown.
 * "It is small" is not a reason — a small body today is the p99 of an
 * unrelated actor at the first large one.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/** Both trees are scanned; both have to be read (see the sanity floors). */
const SCANNED_TREES: readonly string[] = ['src', 'examples'];

/** A single backslash, spelled so no shell heredoc or editor can eat it. */
const BACKSLASH = String.fromCharCode(92);

/**
 * The revision the ledger below was measured at, so a later reader can see how
 * far the tree has moved without re-deriving the baseline.
 */
const LEDGER_REVISION = 'd42876f2';
const LEDGER_MEASURED_ON = '2026-09-18';

/**
 * The closed list.  Node built-ins whose `*Sync` form holds the thread for
 * work a thread pool would otherwise do: zlib, the crypto key derivations,
 * child processes, the filesystem, and `@grpc/proto-loader`'s `loadSync`.
 */
const BLOCKING_SYNC_NAMES: readonly string[] = [
  'gzip', 'gunzip', 'deflate', 'inflate', 'deflateRaw', 'inflateRaw', 'unzip',
  'brotliCompress', 'brotliDecompress', 'zstdCompress', 'zstdDecompress',
  'scrypt', 'pbkdf2', 'hkdf',
  'exec', 'execFile', 'spawn',
  'readFile', 'writeFile', 'appendFile', 'readdir', 'mkdir', 'stat', 'access', 'exists',
  'copyFile', 'rename', 'unlink', 'rm',
  'load',
];

type LedgerEntry = {
  /** Code-position mentions of the name in the file — imports, type members, reads and calls alike. */
  readonly mentions: number;
  /** Why this call is not inside an actor's turn. */
  readonly reason: string;
};

/** File → `*Sync` name → allowance.  Sorted by path; measured at {@link LEDGER_REVISION}. */
type Ledger = Readonly<Record<string, Readonly<Record<string, LedgerEntry>>>>;

/**
 * Blocking `*Sync` mentions per file and name, measured at
 * {@link LEDGER_REVISION} with the scanner below: **14 across 7 files under
 * `src/`, 21 across 5 files under `examples/`**.  `Compression.ts` and the
 * chat backend's `auth/` are absent by design — they are the two fixes this
 * ratchet exists to keep, and an entry for either would be spare budget.
 */
const LEDGER: Ledger = {
  'src/config/Config.ts': {
    existsSync: {
      mentions: 2,
      reason: 'the HOCON config chain is resolved once at startup, before any actor exists; '
        + '`Config.parseFile` is a synchronous API by contract.',
    },
    readFileSync: {
      mentions: 2,
      reason: 'same startup chain — the config files are read before the system that would run on them.',
    },
  },
  'src/devtools/UiAssetRoutes.ts': {
    gunzipSync: {
      mentions: 2,
      reason: 'the identity-encoding fallback for the rare client that sends no `Accept-Encoding: gzip`: '
        + 'one asset decoded once per process and cached, never per request. Stays sync by decision (#1540).',
    },
  },
  'src/http/HttpExtension.ts': {
    readFileSync: {
      mentions: 2,
      reason: 'TLS PEM material is read once when the listener\'s config is read, at startup. '
        + 'Stays sync by decision (#1540).',
    },
  },
  'src/io/broker/GrpcClientActor.ts': {
    loadSync: {
      mentions: 2,
      reason: '`@grpc/proto-loader` parses the `.proto` once in `preStart`; the actor is not receiving yet.',
    },
  },
  'src/io/broker/GrpcServerActor.ts': {
    loadSync: {
      mentions: 2,
      reason: '`@grpc/proto-loader` parses the `.proto` once in `preStart`; the actor is not receiving yet.',
    },
  },
  'src/runtime/entry/EntryModule.ts': {
    existsSync: {
      mentions: 2,
      reason: 'the worker bootstrap resolves its entry module while the thread starts, before its system exists.',
    },
  },
  'examples/chat/backend/main.ts': {
    mkdirSync: {
      mentions: 1,
      reason: 'the data directory is created at boot, before the system starts.',
    },
    readFileSync: {
      mentions: 2,
      reason: 'TLS certificate and key are read at boot, before the system starts.',
    },
  },
  'examples/chat/failover-test.ts': {
    execSync: {
      mentions: 4,
      reason: 'a test harness that finds and kills backend processes by port; nothing here runs inside an actor.',
    },
    existsSync: {
      mentions: 2,
      reason: 'the same harness\'s filesystem set-up.',
    },
    mkdirSync: {
      mentions: 2,
      reason: 'the same harness\'s filesystem set-up.',
    },
    rmSync: {
      mentions: 2,
      reason: 'the same harness\'s filesystem set-up.',
    },
  },
  'examples/io/grpc-sensor.ts': {
    unlinkSync: {
      mentions: 2,
      reason: 'removes the `.proto` fixture after `terminate()`, when no actor is left.',
    },
    writeFileSync: {
      mentions: 2,
      reason: 'writes the `.proto` fixture before the system starts.',
    },
  },
  'examples/persistence/s3-snapshot-bank-account.ts': {
    rmSync: {
      mentions: 2,
      reason: 'temp-directory cleanup after the run.',
    },
  },
  'examples/voice/backend/plugins/staticFilesPlugin.ts': {
    existsSync: {
      mentions: 1,
      reason: 'creates the static root at plugin registration, before the server listens.',
    },
    mkdirSync: {
      mentions: 1,
      reason: 'creates the static root at plugin registration, before the server listens.',
    },
  },
};

/**
 * A floor under the scanner itself, per tree.
 *
 * Every assertion below is satisfied by finding nothing, so a scanner that
 * stopped reading — a moved directory, a blanking bug that ate the file —
 * would report a tree with no blocking calls at all and pass.  The floors sit
 * under what stays permanently: `Config.ts` alone carries four mentions in
 * `src/`, and the chat fail-over harness alone ten in `examples/`, so the
 * migration this ratchet enables cannot trip either, while a tree that went
 * unread trips it at once.  Per tree, because `examples/` being silently
 * dropped from the scan is exactly the failure a single total would hide.
 */
const SCANNER_SANITY_FLOORS: Readonly<Record<string, number>> = { src: 4, examples: 6 };

/**
 * `source` with comments and string literals replaced by spaces, character for
 * character so offsets and line numbers still line up.
 *
 * Whole-file rather than per-line, because a template literal spanning lines
 * would otherwise have its later lines read as code — and a doc comment inside
 * one mentioning `gzipSync` would be counted as a mention.
 *
 * One departure from the `WallClockRatchet.test.ts` copy: a `'` or `"` literal
 * ends at a newline.  Those literals cannot hold a raw newline in JavaScript,
 * so the only way the scan reaches one is a quote that was never a string
 * opener — a `'` inside a regex literal such as `/[&<>"'`]/g` — and then the
 * runaway used to swallow every line up to the next matching quote.  Measured
 * over `src/` and `examples/` at {@link LEDGER_REVISION}: 27 such runaways in
 * six files, 186 lines of code the scanner never read.  Bounding the literal
 * at the line bounds the damage to the rest of that one line.
 */
function blankNonCode(source: string): string {
  const out = source.split('');
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index++; }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < source.length) { out[index] = ' '; out[index + 1] = ' '; index += 2; }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      const spansLines = quote === '`';
      out[index] = ' ';
      index++;
      while (index < source.length) {
        if (source[index] === BACKSLASH) {
          out[index] = ' ';
          if (source[index + 1] !== '\n') out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        if (source[index] === '\n') {
          if (!spansLines) break;
        } else {
          out[index] = ' ';
        }
        index++;
      }
      if (index < source.length && source[index] === quote) { out[index] = ' '; index++; }
      continue;
    }
    index++;
  }
  return out.join('');
}

/**
 * A listed name followed by `Sync`, as a whole identifier.  `\b` on both sides
 * is what keeps `gzipSyncOptions` and `myGzipSync` out and what lets an import
 * specifier, a type member and a call in; the parentheses are deliberately not
 * required (see the header).  Built from a plain string so no shell heredoc
 * can collapse the escapes.
 */
const BLOCKING_SYNC_MENTION = new RegExp(`${BACKSLASH}b(${BLOCKING_SYNC_NAMES.join('|')})Sync${BACKSLASH}b`, 'g');

/** Mentions per `*Sync` name in `source`, comments and strings blanked. */
function blockingSyncMentionsIn(source: string): ReadonlyMap<string, number> {
  const mentions = new Map<string, number>();
  for (const found of blankNonCode(source).matchAll(BLOCKING_SYNC_MENTION)) {
    mentions.set(found[0], (mentions.get(found[0]) ?? 0) + 1);
  }
  return mentions;
}

/**
 * Every `.ts` this repository wrote under `directory`.
 *
 * `generated/` is skipped: `UiAssets.ts` is a committed build artefact holding
 * a bundled Angular application, and counting a minifier's output would make
 * the ledger a function of the bundler.  `node_modules` under an example's
 * frontend is not this repository's code.
 */
function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'generated') continue;
      sourceFiles(join(directory, entry.name), found);
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(join(directory, entry.name));
  }
  return found;
}

const relativeToRoot = (absolutePath: string): string =>
  absolutePath.split(BACKSLASH).join('/')
    .slice(REPOSITORY_ROOT.split(BACKSLASH).join('/').length + 1);

type FileMentions = { readonly tree: string; readonly file: string; readonly mentions: ReadonlyMap<string, number> };

const scanned: readonly FileMentions[] = SCANNED_TREES.flatMap((tree) =>
  sourceFiles(join(REPOSITORY_ROOT, tree))
    .map(relativeToRoot)
    .sort()
    .map((file) => ({ tree, file, mentions: blockingSyncMentionsIn(readFileSync(join(REPOSITORY_ROOT, file), 'utf8')) })));

type SiteMentions = { readonly file: string; readonly name: string; readonly mentions: number };

/** One row per (file, name) the scanner found, which is the grain the ledger is kept at. */
const sites: readonly SiteMentions[] = scanned.flatMap((entry) =>
  [...entry.mentions.entries()].map(([name, mentions]) => ({ file: entry.file, name, mentions })));

const ledgerSites: readonly SiteMentions[] = Object.entries(LEDGER).flatMap(([file, names]) =>
  Object.entries(names).map(([name, entry]) => ({ file, name, mentions: entry.mentions })));

describe('blocking *Sync calls are mentioned in fewer places over time', () => {
  test.each([...SCANNED_TREES])('the scanner reads %s/, the tree it claims to', (tree) => {
    // Every assertion below is satisfied by finding nothing.
    const total = scanned
      .filter((entry) => entry.tree === tree)
      .reduce((sum, entry) => sum + [...entry.mentions.values()].reduce((a, b) => a + b, 0), 0);
    expect(
      total,
      `The scanner found almost no blocking *Sync mentions under ${tree}/, which is far more `
      + 'likely to mean it stopped reading the tree than that every startup read and test harness '
      + `moved. ${SCANNER_SANITY_FLOORS[tree]} or more are permanent there.`,
    ).toBeGreaterThanOrEqual(SCANNER_SANITY_FLOORS[tree] ?? Number.POSITIVE_INFINITY);
  });

  test.each([...sites])(
    '$file mentions $name no more often than the ledger records',
    ({ file, name, mentions }) => {
      const allowed = LEDGER[file]?.[name]?.mentions ?? 0;
      expect(
        mentions,
        `${file} mentions ${name} ${mentions} time(s); the ledger allows ${allowed} `
        + `(measured at ${LEDGER_REVISION}). A blocking call inside an actor's turn holds the one `
        + 'thread every actor in the process runs on. Use the async form the runtime already ships '
        + '(zlib.gzip, crypto.scrypt, fs.promises — tier 1), or move the work to the OffloadPool '
        + '(tier 2). If the call genuinely runs before any actor exists, once per process and cached, '
        + 'or in a test harness, add the entry with that reason written beside it.',
      ).toBeLessThanOrEqual(allowed);
    },
  );

  test('the ledger names no file that has since gone', () => {
    // An entry for a deleted or renamed file is a budget nothing can spend,
    // and it quietly inflates the number the migration is measured against.
    const present = new Set(scanned.map((entry) => entry.file));
    expect(
      Object.keys(LEDGER).filter((file) => !present.has(file)),
      'These ledger entries name files that no longer exist. Remove them — an '
      + 'entry nobody can spend makes the remaining work look larger than it is.',
    ).toEqual([]);
  });

  test('the ledger records no mention that has already reached zero', () => {
    // The end state of a migrated call is no entry, not an entry of the count
    // it used to have. Left behind, it is a budget a later change can spend.
    const found = new Map(sites.map((site) => [`${site.file} ${site.name}`, site.mentions]));
    expect(
      ledgerSites
        .filter((site) => (found.get(`${site.file} ${site.name}`) ?? 0) === 0)
        .map((site) => `${site.file}: ${site.name}`),
      'These files no longer mention the name their ledger entry allows, so the entry is spare '
      + 'budget a later change could spend without anyone noticing. Delete it.',
    ).toEqual([]);
  });

  test('every ledger entry says why its call is not inside an actor\'s turn', () => {
    // The reason is the entry: a count without one is an allowance, not a
    // decision, and the header says which reasons count.
    expect(
      Object.entries(LEDGER).flatMap(([file, names]) =>
        Object.entries(names)
          .filter(([, entry]) => entry.reason.trim().length === 0 || entry.mentions <= 0)
          .map(([name]) => `${file}: ${name}`)),
    ).toEqual([]);
  });

  test('the ledger is dated, so its distance from today is readable', () => {
    // Not a behaviour check. The pair is load-bearing documentation and this is
    // what keeps one of them from being updated without the other.
    expect(LEDGER_REVISION).toMatch(/^[0-9a-f]{8}$/);
    expect(LEDGER_MEASURED_ON).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  });
});

/** The total for a fixture, across every listed name. */
function totalMentionsIn(source: string): number {
  return [...blockingSyncMentionsIn(source).values()].reduce((sum, count) => sum + count, 0);
}

describe('the guards on the guard', () => {
  test('the scanner counts a call', () => {
    expect(totalMentionsIn('const out = zlib.gzipSync(input, { level: 9 });')).toBe(1);
  });

  test('it counts an aliased read, which a call-shaped regex would miss', () => {
    // The shape every zstd call in the old Compression.ts had: the sync
    // function captured into a local and called through it.
    expect(totalMentionsIn('const bunCompress = bun?.zstdCompressSync;')).toBe(1);
  });

  test('it counts an import specifier and a type-literal member', () => {
    expect(totalMentionsIn("import { readFileSync } from 'node:fs';")).toBe(1);
    expect(totalMentionsIn('const zlib = mod as { gunzipSync(input: Uint8Array): Uint8Array };')).toBe(1);
  });

  test('it counts each listed name separately', () => {
    const mentions = blockingSyncMentionsIn("import { existsSync, readFileSync } from 'node:fs'; if (existsSync(p)) readFileSync(p);");
    expect(mentions.get('existsSync')).toBe(2);
    expect(mentions.get('readFileSync')).toBe(2);
  });

  test('it does not count a mention inside a comment or a string', () => {
    expect(totalMentionsIn('// gzipSync in prose')).toBe(0);
    expect(totalMentionsIn('/** never call scryptSync from a handler */')).toBe(0);
    expect(totalMentionsIn("const note = 'zlib.gzipSync is blocking';")).toBe(0);
  });

  test('it does not count a mention inside a multi-line template literal', () => {
    // The reason the scanner blanks whole-file rather than per line: a per-line
    // scanner resumes reading code on the second line of a template.
    const source = ['const doc = `', '  readFileSync() appears here as prose.', '`;'].join('\n');
    expect(totalMentionsIn(source)).toBe(0);
  });

  test('it does not count names off the list, however they end', () => {
    // `reconcileSync` is a method name, `Lazy.getSync` a memo accessor, and
    // node:sqlite's `DatabaseSync` is synchronous by design (see the header).
    expect(totalMentionsIn('this.reconcileSync(); const value = lazy.getSync(); new DatabaseSync(path);')).toBe(0);
  });

  test('it matches whole identifiers only', () => {
    expect(totalMentionsIn('const gzipSyncOptions = {}; const myGzipSync = 1;')).toBe(0);
  });

  test('it counts a mention that follows a blanked region', () => {
    // A blanking bug that ran off the end would swallow the rest of the file,
    // and every assertion above would pass on a tree it never read.
    const source = "/* gzipSync() */ const s = 'x'; const t = zlib.gzipSync(s);";
    expect(totalMentionsIn(source)).toBe(1);
  });

  test('a quote inside a regex literal blanks at most the rest of its line', () => {
    // `/'/` opens what the blanker takes for a string and nothing on the line
    // closes it.  The copy this scanner started from ran on to the next `'`
    // in the file — 186 lines of src/ went unread that way — so the literal
    // now ends at the newline, which a real `'` or `"` string cannot cross.
    const source = ["const quote = /'/g;", 'const out = zlib.gzipSync(input);', "const other = 'x';"].join('\n');
    expect(totalMentionsIn(source)).toBe(1);
    // A backslash-newline continuation is still one string, and a template
    // literal still spans lines (see the multi-line template test above).
    const continued = ["const s = 'abc\\", "def'; zlib.gzipSync(x);"].join('\n');
    expect(totalMentionsIn(continued)).toBe(1);
  });

  test('it reads a CRLF file the same as an LF one', () => {
    // Windows checkouts under core.autocrlf hand the scanner \r\n; a line
    // comment has to end at the newline either way, or the code on the next
    // line is blanked with it.
    const lf = 'const a = zlib.gzipSync(x);\n// gzipSync in prose\nconst b = fs.readFileSync(p);\n';
    const crlf = lf.split('\n').join('\r\n');
    expect(totalMentionsIn(lf)).toBe(2);
    expect(totalMentionsIn(crlf)).toBe(2);
  });
});
