import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { isSubstitution, parseHocon, type ConfigObject } from '../../../src/config/HoconParser.js';
import { BrokerActor } from '../../../src/io/broker/BrokerActor.js';
import { brokerCommonKeysUnder } from '../../../src/io/broker/BrokerOptions.js';
import { GrpcServerActor } from '../../../src/io/broker/GrpcServerActor.js';

/**
 * **Every key the io pages publish under `actor-ts.io.broker` is one a reader
 * reads** (#1443).
 *
 * `HoconFenceKeys` holds the same fences to a spelling, and a spelling is all
 * it can see: `max-connection` for `max-connections`, a listener's leaf written
 * into the client's block, a shared leaf under the one root whose actor has
 * none — each of them is kebab-case.  This package has no unknown-key
 * detection, so an operator who copies such a sample gets a setting nothing
 * reads and nothing reports.  The readers address their leaves through
 * `ConfigKeys.io.broker`, and `BrokerConfigCompleteness` and
 * `BrokerPathsNamedInSource` hold them to it, so the paths declared there —
 * plus the reconnect, circuit-breaker and outbound-buffer leaves
 * `brokerCommonKeysUnder` composes under every `BrokerActor` root — are the
 * keys a fence may publish.  A key is judged by its full path, so it has to be
 * declared under the root its block sits in.
 *
 * ## What counts as a key
 *
 * `HoconFenceKeys`' rule — a name followed by `=`, `:` or `{`, commented-out
 * ones included — with two refinements, because here every key is resolved
 * against its block instead of merely spelt:
 *
 * - A key starts a field: the start of a line, or after `{` or `,`.  Inside a
 *   list nothing is a key; quoted strings and `${…}` substitutions are values,
 *   so the `#`, `//` and braces in them are neither comments nor blocks; and a
 *   trailing `#` or `//` comment is a comment.
 * - A commented-out line counts when it is a field itself
 *   (`# max-connections = 1024`), and it is read in the block it sits in, so a
 *   commented-out key is held to the same paths as a live one.  Comment
 *   *prose* does not count, although `HoconFenceKeys` scans it too:
 *   `# max-attempts omitted = unlimited` on the BrokerActor base page puts
 *   `omitted` in key position, and the JetStream page's `# or: { … }` puts `or`
 *   there.  Neither is camelCase, so neither troubles a spelling check — and
 *   neither is a leaf, so both would fail this one.  A comment is a field only
 *   when `=` or `{` follows its first word, never `:`, which in a comment is
 *   punctuation far more often than a separator.
 *
 * The scan is held to the real parser: every leaf `parseHocon` finds in a fence
 * must be one the scan found, so a key the scan misses fails here instead of
 * going unchecked.
 *
 * ## Fragments and exemptions
 *
 * A fence that does not start from `actor-ts` continues a block an earlier
 * fence opened — `io/jetstream.mdx` shows `consumer { … }` on its own to
 * explain `deliver-policy` — and is read under the one root the page's other
 * fences open.  On a page that opens several it would be ambiguous, which fails:
 * write the root out.
 *
 * `sse`'s `headers` block holds application data: its keys are the HTTP header
 * names the request sends, which no `ConfigKeys` entry can list.
 *
 * ## The configuration page's table
 *
 * `reference/configuration.mdx` lists every broker subtree with the page that
 * publishes its keys.  Each root `ConfigKeys` declares has a row there, each
 * row is a root, and the page a row names publishes at least one of that
 * root's own leaves in a HOCON fence, in both languages — so "see the
 * per-protocol pages for the keys" holds for every root.  The two languages
 * publish the same HOCON, fence for fence, since a German sample is copied as
 * often as an English one.
 *
 * What this cannot see: HOCON in a fence not tagged `hocon`; a key named in
 * comment prose, or commented out with `:` (`# max-connection: 5`), by the rule
 * above; a value of the wrong kind (a duration where a size belongs); a key
 * under `actor-ts` but outside `actor-ts.io` (`actor-ts.oi.broker…`); and a
 * plain actor added under `io.broker` without an entry in
 * `ROOTS_WITHOUT_SHARED_LEAVES`, which would be granted the shared leaves.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** Where each language keeps its io pages, and the configuration page whose table points at them. */
const LANGUAGES = [
  { language: 'English', ioDirectory: 'io', configurationPage: 'reference/configuration.mdx' },
  { language: 'German', ioDirectory: 'de/io', configurationPage: 'de/reference/configuration.mdx' },
] as const;

type Language = (typeof LANGUAGES)[number];

/** The subtree this checks: every path under it must be one `ConfigKeys` declares. */
const NAMESPACE = 'actor-ts.io';

type KeyTree = { readonly [accessor: string]: string | KeyTree };

/** One broker block: its root, and the group of keys `ConfigKeys` declares for it. */
type BrokerBlock = { readonly root: string; readonly group: KeyTree };

/** Every path in a group of keys, at any depth. */
function pathsOf(keys: KeyTree): string[] {
  return Object.values(keys).flatMap((value) => (typeof value === 'string' ? [value] : pathsOf(value)));
}

/**
 * Every group that carries a `root` and sits in no other group.  `grpc` carries
 * none — it only groups the client's block with the server's — so the walk goes
 * through it to both.
 */
function brokerBlocksIn(keys: KeyTree): BrokerBlock[] {
  const root = keys['root'];
  if (typeof root === 'string') return [{ root, group: keys }];
  return Object.values(keys).flatMap((value) => (typeof value === 'string' ? [] : brokerBlocksIn(value)));
}

const BROKER_BLOCKS: ReadonlyArray<BrokerBlock> = brokerBlocksIn(ConfigKeys.io.broker as unknown as KeyTree);
const BROKER_ROOTS: ReadonlyArray<string> = BROKER_BLOCKS.map((block) => block.root);

/**
 * Roots whose actor is not a `BrokerActor`, with the reason: the reconnect,
 * circuit-breaker and outbound-buffer leaves are `BrokerActor`'s, so under these
 * a fence that set them would publish a block nothing reads.
 */
const ROOTS_WITHOUT_SHARED_LEAVES: ReadonlyMap<string, string> = new Map([
  [ConfigKeys.io.broker.grpc.server.root, 'GrpcServerActor is a plain actor, so nothing reads the shared leaves under its root'],
]);

/**
 * Blocks whose keys are application data rather than settings, with the
 * reason.  The block's own key is checked; what is inside it is not.
 */
const APPLICATION_DATA_BLOCKS: ReadonlyMap<string, string> = new Map([
  [ConfigKeys.io.broker.sse.headers, 'its keys are the HTTP header names the request sends, read as one block'],
]);

/** Every path a fence may publish under {@link NAMESPACE}. */
const DECLARED_PATHS: ReadonlySet<string> = new Set([
  ...pathsOf(ConfigKeys.io as unknown as KeyTree),
  ...BROKER_ROOTS
    .filter((root) => !ROOTS_WITHOUT_SHARED_LEAVES.has(root))
    .flatMap((root) => pathsOf(brokerCommonKeysUnder(root) as unknown as KeyTree)),
]);

/* ------------------------------ the fences ------------------------------ */

/**
 * The opening fence of a HOCON sample — indented ones included, as in
 * `HoconFenceKeys`, and ones carrying a title, which would otherwise be a way
 * past both guards.
 */
const HOCON_FENCE_OPEN = /^[ \t]*```hocon(?:[ \t].*)?$/;
/** Any fence delimiter; the first one after an opening fence closes it. */
const FENCE_DELIMITER = /^[ \t]*```/;

type HoconFence = {
  /** The page, relative to the docs root. */
  readonly page: string;
  /** 1-based line of the opening fence. */
  readonly line: number;
  readonly body: ReadonlyArray<string>;
};

/** Every HOCON fence on `page`, in order. */
function hoconFencesIn(page: string, text: string): HoconFence[] {
  const out: HoconFence[] = [];
  let open: { readonly line: number; readonly body: string[] } | undefined;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (open === undefined) {
      if (HOCON_FENCE_OPEN.test(line)) open = { line: index + 1, body: [] };
    } else if (FENCE_DELIMITER.test(line)) {
      out.push({ page, line: open.line, body: open.body });
      open = undefined;
    } else {
      open.body.push(line);
    }
  }
  return out;
}

/* ------------------------------- the scan ------------------------------- */

/** One key a fence publishes. */
type FenceKey = {
  /** The dotted path from the fence's top level. */
  readonly path: string;
  /** 1-based line on the page. */
  readonly line: number;
  /** The key names a block (`key {`, `key = {`) rather than a value. */
  readonly opensBlock: boolean;
  /** Written as a commented-out field. */
  readonly commentedOut: boolean;
};

/** A line that is a comment from its first character on. */
const COMMENT_LINE = /^[ \t]*(?:#|\/\/)/;
/** The markers in front of a commented-out line. */
const COMMENT_MARKERS = /^[ \t]*(?:#+|\/\/+)/;
/** A commented-out line that is a field itself: a key, then `=` or `{` — not `:`, see the header. */
const COMMENTED_OUT_FIELD = /^[ \t]*[A-Za-z_][A-Za-z0-9_.-]*[ \t]*(?:=|\{)/;
/** A commented-out line that closes a commented-out block. */
const COMMENTED_OUT_CLOSE = /^[ \t]*\}/;
/** A quoted string, escapes included — a value, whatever `#`, `//` or braces it holds. */
const QUOTED_STRING = /"(?:[^"\\]|\\.)*"/g;
/** A substitution such as `${?SECRET}` — a value, and its braces are no block. */
const SUBSTITUTION = /\$\{[^}]*\}/g;
/** Where a trailing comment starts, once the strings are out of the way. */
const TRAILING_COMMENT = /#|\/\//;
/** A key at the start of a field, a dotted path being one key, and the separator after it. */
const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*(=|:|\{)/;
/** The `{` after a key's `=` or `:`, which makes the value a block. */
const OBJECT_VALUE = /^[ \t]*\{/;

/**
 * Where a scan is: the path segments each open block added (none for a bare
 * `{`), and how deep in a list it is, where nothing is a key.
 */
class ScanPosition {
  constructor(
    private readonly blocks: string[][] = [],
    private listDepth = 0,
  ) {}

  /** The same position, for a run of commented-out lines that must not move this one. */
  copy(): ScanPosition {
    return new ScanPosition(this.blocks.map((segments) => [...segments]), this.listDepth);
  }

  /** Scan one line, its comment markers already removed, adding the keys it holds to `out`. */
  scan(text: string, line: number, commentedOut: boolean, out: FenceKey[]): void {
    let code = text.replace(QUOTED_STRING, '""').replace(SUBSTITUTION, '$');
    const comment = code.search(TRAILING_COMMENT);
    if (comment >= 0) code = code.slice(0, comment);
    let atFieldStart = true;
    let index = 0;
    while (index < code.length) {
      const character = code[index]!;
      if (character === ' ' || character === '\t') {
        index++;
      } else if (this.listDepth > 0) {
        if (character === '[') this.listDepth++;
        else if (character === ']') this.listDepth--;
        index++;
      } else if (character === '[') {
        this.listDepth = 1;
        atFieldStart = false;
        index++;
      } else if (character === '{') {
        this.blocks.push([]);
        atFieldStart = true;
        index++;
      } else if (character === '}') {
        this.blocks.pop();
        atFieldStart = false;
        index++;
      } else if (character === ',') {
        atFieldStart = true;
        index++;
      } else {
        const key: RegExpExecArray | null = atFieldStart ? KEY.exec(code.slice(index)) : null;
        if (key === null) {
          atFieldStart = false;
          index++;
          continue;
        }
        index += key[0].length;
        const objectValue: RegExpExecArray | null = key[2] === '{' ? null : OBJECT_VALUE.exec(code.slice(index));
        if (objectValue !== null) index += objectValue[0].length;
        const opensBlock: boolean = key[2] === '{' || objectValue !== null;
        const segments = key[1]!.split('.');
        out.push({ path: [...this.blocks.flat(), ...segments].join('.'), line, opensBlock, commentedOut });
        if (opensBlock) this.blocks.push(segments);
        atFieldStart = opensBlock;
      }
    }
  }
}

/** The keys `fence` publishes, at their paths from the fence's top level. */
function keysIn(fence: HoconFence): FenceKey[] {
  const out: FenceKey[] = [];
  const position = new ScanPosition();
  let commentedOut: ScanPosition | undefined;
  for (const [offset, text] of fence.body.entries()) {
    const line = fence.line + 1 + offset;
    if (!COMMENT_LINE.test(text)) {
      commentedOut = undefined;
      position.scan(text, line, false, out);
      continue;
    }
    const uncommented = text.replace(COMMENT_MARKERS, '');
    if (!COMMENTED_OUT_FIELD.test(uncommented) && !COMMENTED_OUT_CLOSE.test(uncommented)) continue;
    commentedOut ??= position.copy();
    commentedOut.scan(uncommented, line, true, out);
  }
  return out;
}

/** Every leaf the parser finds in `tree`, a substitution being a leaf. */
function parsedLeafPaths(tree: ConfigObject, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const isBlock = typeof value === 'object' && value !== null && !Array.isArray(value) && !isSubstitution(value);
    return isBlock ? parsedLeafPaths(value as ConfigObject, path) : [path];
  });
}

/* ------------------------------ the check ------------------------------- */

/** A fence read for broker keys. */
type BrokerFence = HoconFence & {
  /** Its keys at full paths — under `fragmentRoot` for a fragment. */
  readonly keys: ReadonlyArray<FenceKey>;
  /** For a fragment, the root it was read under. */
  readonly fragmentRoot?: string;
  /** For a fragment on a page that opens several roots, those roots. */
  readonly ambiguousRoots?: ReadonlyArray<string>;
};

function underNamespace(path: string): boolean {
  return path === NAMESPACE || path.startsWith(`${NAMESPACE}.`);
}

/** The root `path` is under, if any. */
function rootOf(path: string): string | undefined {
  return BROKER_ROOTS.find((root) => path === root || path.startsWith(`${root}.`));
}

/**
 * The broker fences on one page: every fence with a key under
 * {@link NAMESPACE}, and every fragment, read under the one root the page's
 * other fences open.
 */
function brokerFencesOf(page: string, text: string): BrokerFence[] {
  const fences = hoconFencesIn(page, text).map((fence) => ({ ...fence, keys: keysIn(fence) }));
  const isFragment = (keys: ReadonlyArray<FenceKey>): boolean =>
    keys.length > 0 && keys.every((key) => key.path !== 'actor-ts' && !key.path.startsWith('actor-ts.'));
  const opened = [...new Set(fences
    .filter((fence) => !isFragment(fence.keys))
    .flatMap((fence) => fence.keys.flatMap((key) => rootOf(key.path) ?? [])))];
  const out: BrokerFence[] = [];
  for (const fence of fences) {
    if (!isFragment(fence.keys)) {
      if (fence.keys.some((key) => underNamespace(key.path))) out.push(fence);
    } else if (opened.length === 1) {
      const root = opened[0]!;
      out.push({ ...fence, fragmentRoot: root, keys: fence.keys.map((key) => ({ ...key, path: `${root}.${key.path}` })) });
    } else if (opened.length > 1) {
      out.push({ ...fence, ambiguousRoots: opened });
    }
  }
  return out;
}

/** True when `path` sits inside a block of application data. */
function isApplicationData(path: string): boolean {
  return [...APPLICATION_DATA_BLOCKS.keys()].some((block) => path.startsWith(`${block}.`));
}

/** True when `path` is a block that holds declared paths without being one — `actor-ts.io.broker.grpc`. */
function holdsDeclaredPaths(path: string): boolean {
  return [...DECLARED_PATHS].some((declared) => declared.startsWith(`${path}.`));
}

/** The keys under {@link NAMESPACE} that no reader reads. */
function unreadKeys(keys: ReadonlyArray<FenceKey>): FenceKey[] {
  return keys.filter((key) =>
    underNamespace(key.path)
    && !isApplicationData(key.path)
    && !DECLARED_PATHS.has(key.path)
    && !(key.opensBlock && holdsDeclaredPaths(key.path)));
}

function described(fence: HoconFence, key: FenceKey): string {
  return `${fence.page}:${key.line} ${key.path}${key.commentedOut ? ' (commented out)' : ''}`;
}

/* ---------------------------- the docs tree ----------------------------- */

type DocsPage = { readonly page: string; readonly text: string };

/** The io pages of one language. */
function ioPagesOf(language: Language): DocsPage[] {
  const directory = join(DOCS_ROOT, ...language.ioDirectory.split('/'));
  return readdirSync(directory)
    .filter((name) => name.endsWith('.mdx') || name.endsWith('.md'))
    .sort()
    .map((name) => ({ page: `${language.ioDirectory}/${name}`, text: readFileSync(join(directory, name), 'utf8') }));
}

const IO_PAGES: ReadonlyMap<Language, ReadonlyArray<DocsPage>> = new Map(
  LANGUAGES.map((language) => [language, ioPagesOf(language)]),
);

const BROKER_FENCES: ReadonlyArray<BrokerFence> = [...IO_PAGES.values()]
  .flat()
  .flatMap(({ page, text }) => brokerFencesOf(page, text));

/** The heading of the configuration page's broker section, in either language. */
const BROKER_SECTION_HEADING = /^#{2,3} .*`actor-ts\.io\.broker\.\*`/;
/** A row of its table: `` | `io.broker.tcp` | [TCP](/io/tcp/) | ``. */
const BROKER_TABLE_ROW = /^\|\s*`io\.broker\.([A-Za-z0-9.{},-]+)`\s*\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|\s*$/;

/** `grpc.{client,server}` → `grpc.client`, `grpc.server`. */
function expandBraces(subtree: string): string[] {
  const braces = /^(.*)\{([^}]*)\}(.*)$/.exec(subtree);
  if (braces === null) return [subtree];
  return braces[2]!.split(',').flatMap((choice) => expandBraces(`${braces[1]}${choice.trim()}${braces[3]}`));
}

/** The configuration page's broker table: each root it lists, mapped to the page it names. */
function brokerTableOf(language: Language): Map<string, string> {
  const lines = readFileSync(join(DOCS_ROOT, ...language.configurationPage.split('/')), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => BROKER_SECTION_HEADING.test(line));
  const table = new Map<string, string>();
  if (start < 0) return table;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(line)) break;
    const row = BROKER_TABLE_ROW.exec(line);
    if (row === null) continue;
    const page = `${row[2]!.replace(/^\/|\/$/g, '')}.mdx`;
    for (const subtree of expandBraces(row[1]!)) table.set(`actor-ts.io.broker.${subtree}`, page);
  }
  return table;
}

/** A synthetic fence, for the cases that check the check. */
function fenceOf(lines: ReadonlyArray<string>, page = 'probe.mdx'): HoconFence {
  return { page, line: 1, body: lines };
}

function unreadIn(lines: ReadonlyArray<string>): string[] {
  return unreadKeys(keysIn(fenceOf(lines))).map((key) => key.path);
}

/* -------------------------------- tests --------------------------------- */

describe('every key the io pages publish under actor-ts.io.broker is one a reader reads', () => {
  test('the scan finds keys by the block they sit in, and nothing in comment prose', () => {
    // Guards the guard: a scan that found nothing would pass every fence.
    const probe = fenceOf([
      'actor-ts.io.broker.tcp-server {',
      '  bind-port = 9000   # 0 lets the OS pick; max-connection = 1 here is a comment',
      '  framing { kind = "lines", max-line-bytes = 64K }',
      '  # max-connections = 1024',
      '  # max-attempts omitted = unlimited (the default)',
      '  # or:          { kind = "by-start-time", start-time = 1 }',
      '  url = "a#b//c{d}"',
      '  servers = [',
      '    { not-a-key = 1 }',
      '  ]',
      '  password = ${?SECRET}',
      '  reconnect = { initial-delay = 1s }',
      '}',
    ]);
    expect(keysIn(probe).map((key) => `${key.path}${key.commentedOut ? ' #' : ''}${key.opensBlock ? ' {' : ''}`)).toEqual([
      'actor-ts.io.broker.tcp-server {',
      'actor-ts.io.broker.tcp-server.bind-port',
      'actor-ts.io.broker.tcp-server.framing {',
      'actor-ts.io.broker.tcp-server.framing.kind',
      'actor-ts.io.broker.tcp-server.framing.max-line-bytes',
      'actor-ts.io.broker.tcp-server.max-connections #',
      'actor-ts.io.broker.tcp-server.url',
      'actor-ts.io.broker.tcp-server.servers',
      'actor-ts.io.broker.tcp-server.password',
      'actor-ts.io.broker.tcp-server.reconnect {',
      'actor-ts.io.broker.tcp-server.reconnect.initial-delay',
    ]);

    // A commented-out block is read in place and leaves the live nesting alone.
    const commentedBlock = keysIn(fenceOf([
      'actor-ts.io.broker.tcp {',
      '  # framing {',
      '  #   max-frame-bytes = 16M',
      '  # }',
      '  host = "example.com"',
      '}',
    ])).map((key) => key.path);
    expect(commentedBlock).toEqual([
      'actor-ts.io.broker.tcp',
      'actor-ts.io.broker.tcp.framing',
      'actor-ts.io.broker.tcp.framing.max-frame-bytes',
      'actor-ts.io.broker.tcp.host',
    ]);

    // CRLF pages and titled fences are found like any other.
    const crlf = hoconFencesIn('probe.mdx', ['text', '```hocon title="application.conf"', 'actor-ts.io.broker.udp {', '  bind-port = 1', '}', '```'].join('\r\n'));
    expect(crlf.flatMap((fence) => keysIn(fence)).map((key) => key.path)).toEqual([
      'actor-ts.io.broker.udp',
      'actor-ts.io.broker.udp.bind-port',
    ]);
  });

  test('the check refuses a misspelt key, a key under the wrong root, a retired spelling and an unread shared leaf', () => {
    expect(unreadIn(['actor-ts.io.broker.tcp-server {', '  max-connection = 10', '}']))
      .toEqual(['actor-ts.io.broker.tcp-server.max-connection']);
    expect(unreadIn(['actor-ts.io.broker.tcp-server {', '  # max-connection = 10', '}']))
      .toEqual(['actor-ts.io.broker.tcp-server.max-connection']);
    expect(unreadIn(['actor-ts.io.broker.tcp {', '  max-connections = 10', '}']))
      .toEqual(['actor-ts.io.broker.tcp.max-connections']);
    expect(unreadIn(['actor-ts.io.broker.tcp-server {', '  maxConnections = 10', '}']))
      .toEqual(['actor-ts.io.broker.tcp-server.maxConnections']);
    expect(unreadIn(['actor-ts.io.broker.tcp.framing.maxLineLen = 64K']))
      .toEqual(['actor-ts.io.broker.tcp.framing.maxLineLen']);
    expect(unreadIn(['actor-ts.io.broker.grpc.server {', '  reconnect { max-attempts = 1 }', '}']))
      .toEqual(['actor-ts.io.broker.grpc.server.reconnect', 'actor-ts.io.broker.grpc.server.reconnect.max-attempts']);
    expect(unreadIn(['actor-ts.io.brokers.tcp {', '  host = "example.com"', '}']))
      .toEqual(['actor-ts.io.brokers.tcp', 'actor-ts.io.brokers.tcp.host']);
    expect(unreadIn(['actor-ts {', '  io.broker.redisStreams { url = "redis://localhost" }', '}']))
      .toEqual(['actor-ts.io.broker.redisStreams', 'actor-ts.io.broker.redisStreams.url']);
    // The headers exemption covers what is inside the block, not its neighbours.
    expect(unreadIn(['actor-ts.io.broker.sse {', '  headers { authorization = "x" }', '  idle-timout = 60s', '}']))
      .toEqual(['actor-ts.io.broker.sse.idle-timout']);

    // What it accepts: declared leaves, the shared ones under a BrokerActor
    // root, the blocks that hold them, and whatever an application-data block holds.
    expect(unreadIn([
      'actor-ts.io.broker.grpc {',
      '  client { deadline = 30s, reconnect.max-attempts = 1 }',
      '  server { bind = "0.0.0.0:50051" }',
      '}',
      'actor-ts.io.broker.sse.headers { x-anything-at-all = "1" }',
      'actor-ts.http.server.port = 8080',
    ])).toEqual([]);
  });

  test('a fragment is read under the one root its page opens, and fails on a page that opens two', () => {
    const one = brokerFencesOf('one.mdx', [
      '```hocon', 'actor-ts.io.broker.jetstream { acknowledgment-timeout = 45s }', '```',
      '```hocon', 'consumer {', '  durable = "billing"', '  ack-wait = 30s', '}', '```',
    ].join('\n'));
    expect(one.map((fence) => fence.fragmentRoot)).toEqual([undefined, ConfigKeys.io.broker.jetstream.root]);
    expect(one.flatMap((fence) => unreadKeys(fence.keys))).toEqual([]);

    const two = brokerFencesOf('two.mdx', [
      '```hocon', 'actor-ts.io.broker.tcp { port = 1 }', 'actor-ts.io.broker.udp { bind-port = 1 }', '```',
      '```hocon', 'host = "example.com"', '```',
    ].join('\n'));
    expect(two[1]?.ambiguousRoots).toEqual([ConfigKeys.io.broker.tcp.root, ConfigKeys.io.broker.udp.root]);
  });

  test('the paths it accepts are the declared and the composed ones, and only under the roots that read them', () => {
    // A key tree that declared no leaf — every io.broker entry a bare root —
    // would leave nothing to accept and every fence red; these pin that it is not.
    expect(BROKER_ROOTS).toContain(ConfigKeys.io.broker.tcpServer.root);
    expect(BROKER_ROOTS).toContain(ConfigKeys.io.broker.grpc.server.root);
    expect(BROKER_ROOTS.length).toBeGreaterThanOrEqual(16);
    expect(DECLARED_PATHS.has(ConfigKeys.io.broker.tcpServer.maxConnections)).toBe(true);
    expect(DECLARED_PATHS.has(ConfigKeys.io.broker.tcp.framing.maxFrameBytes)).toBe(true);
    expect(DECLARED_PATHS.has('actor-ts.io.broker.kafka.reconnect.initial-delay')).toBe(true);
    expect(DECLARED_PATHS.has('actor-ts.io.broker.grpc.client.circuit-breaker')).toBe(true);
    // The breaker is named by id at a broker's root; its numbers are not broker keys (#1478).
    expect(DECLARED_PATHS.has('actor-ts.io.broker.grpc.client.circuit-breaker.reset')).toBe(false);
    expect(DECLARED_PATHS.has('actor-ts.io.broker.grpc.server.reconnect')).toBe(false);
    expect(DECLARED_PATHS.has('actor-ts.io.broker.tcp.max-connections')).toBe(false);
  });

  test('each exemption still stands for the reason it gives', () => {
    // A plain actor today; were it to become a BrokerActor, the shared leaves
    // would be read under its root and the entry would hide real keys.
    expect(GrpcServerActor.prototype instanceof BrokerActor).toBe(false);
    for (const block of APPLICATION_DATA_BLOCKS.keys()) {
      for (const language of LANGUAGES) {
        const used = BROKER_FENCES
          .filter((fence) => fence.page.startsWith(`${language.ioDirectory}/`))
          .some((fence) => fence.keys.some((key) => key.path.startsWith(`${block}.`)));
        expect(used, `no ${language.language} fence puts a key in ${block} — drop its exemption`).toBe(true);
      }
    }
  });

  test.each([...LANGUAGES])('the scan reaches the $language io pages, fragments included', (language) => {
    const fences = BROKER_FENCES.filter((fence) => fence.page.startsWith(`${language.ioDirectory}/`));
    const rootsOn = (name: string): string[] => [...new Set(fences
      .filter((fence) => fence.page === `${language.ioDirectory}/${name}`)
      .flatMap((fence) => fence.keys.flatMap((key) => rootOf(key.path) ?? [])))].sort();
    expect(rootsOn('tcp.mdx')).toEqual([ConfigKeys.io.broker.tcp.root, ConfigKeys.io.broker.tcpServer.root]);
    expect(rootsOn('grpc.mdx')).toEqual([ConfigKeys.io.broker.grpc.client.root, ConfigKeys.io.broker.grpc.server.root]);
    const fragments = fences.filter((fence) => fence.fragmentRoot !== undefined);
    expect(fragments.map((fence) => [fence.page, fence.fragmentRoot])).toEqual([
      [`${language.ioDirectory}/jetstream.mdx`, ConfigKeys.io.broker.jetstream.root],
    ]);
  });

  test.each(BROKER_FENCES.map((fence) => ({ ...fence, name: `${fence.page}:${fence.line}` })))(
    '$name publishes only keys a reader reads',
    (fence) => {
      expect(
        fence.ambiguousRoots ?? [],
        `${fence.name} continues a block without naming it, on a page that opens several roots — write the root out.`,
      ).toEqual([]);
      expect(
        unreadKeys(fence.keys).map((key) => described(fence, key)),
        `${fence.name} publishes a key that no reader reads: nothing in ConfigKeys.io.broker declares it under `
        + 'this root, and it is none of the shared leaves brokerCommonKeysUnder composes under a BrokerActor root.  '
        + 'An operator who copies it gets a setting that is silently ignored.',
      ).toEqual([]);
    },
  );

  test.each([...IO_PAGES.values()].flat().flatMap(({ page, text }) => hoconFencesIn(page, text))
    .map((fence) => ({ ...fence, name: `${fence.page}:${fence.line}` })))(
    '$name parses, and the scan finds every key the parser does',
    (fence) => {
      const scanned = new Set(keysIn(fence).filter((key) => !key.commentedOut).map((key) => key.path));
      const missed = parsedLeafPaths(parseHocon(fence.body.join('\n'))).filter((path) => !scanned.has(path));
      expect(missed, `the scan does not see these keys of ${fence.name}, so nothing checks them`).toEqual([]);
    },
  );

  test.each([...LANGUAGES])('the $language configuration page lists every broker root, and nothing else', (language) => {
    const listed = [...brokerTableOf(language).keys()].sort();
    expect(listed, `${language.configurationPage}'s broker table and ConfigKeys.io.broker disagree`)
      .toEqual([...BROKER_ROOTS].sort());
  });

  test.each(LANGUAGES.flatMap((language) => BROKER_BLOCKS.map((block) => ({
    ...block,
    language,
    languageName: language.language,
  }))))(
    '$root publishes its own keys on the page the $languageName configuration page names',
    ({ root, group, language }) => {
      const page = brokerTableOf(language).get(root);
      expect(page, `${language.configurationPage} has no row for ${root}`).toBeDefined();
      const ownLeaves = new Set(pathsOf(group).filter((path) => path !== root));
      const published = BROKER_FENCES
        .filter((fence) => fence.page === page)
        .flatMap((fence) => fence.keys.filter((key) => ownLeaves.has(key.path)));
      expect(
        published.length,
        `${page} publishes none of ${root}'s own keys in a HOCON fence, while ${language.configurationPage} `
        + 'sends the reader there for them.',
      ).toBeGreaterThan(0);
    },
  );

  test.each(IO_PAGES.get(LANGUAGES[0])!.map(({ page, text }) => ({ page, text })))(
    '$page and its German mirror publish the same HOCON',
    ({ page, text }) => {
      const mirror = IO_PAGES.get(LANGUAGES[1])!.find((candidate) => candidate.page === `de/${page}`);
      expect(mirror, `${page} has no German mirror`).toBeDefined();
      const bodies = (fences: ReadonlyArray<HoconFence>): string[] => fences.map((fence) => fence.body.join('\n'));
      expect(
        bodies(hoconFencesIn(`de/${page}`, mirror?.text ?? '')),
        'the code of a HOCON sample is identical in both languages; only the prose around it is translated.',
      ).toEqual(bodies(hoconFencesIn(page, text)));
    },
  );
});
