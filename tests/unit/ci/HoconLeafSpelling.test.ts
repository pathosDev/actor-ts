import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'bun:test';
import type { ActorSystem } from '../../../src/ActorSystem.js';
import { CacheExtensionId } from '../../../src/cache/CacheExtension.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { parseHocon } from '../../../src/config/HoconParser.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import type { WebsocketServerRef } from '../../../src/http/websocket/WebsocketMessages.js';
import { websocket } from '../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketServerActor } from '../../../src/http/websocket/WebsocketServerActor.js';
import {
  RETIRED_BROKER_CIRCUIT_BREAKER_LEAVES,
  RETIRED_BROKER_COMMON_LEAVES,
} from '../../../src/io/broker/BrokerOptions.js';
import { GrpcServerActor } from '../../../src/io/broker/GrpcServerActor.js';
import { MqttActor } from '../../../src/io/broker/MqttActor.js';
import { RETIRED_TCP_FRAMING_LEAVES } from '../../../src/io/broker/TcpFraming.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { createTestActorSystem } from '../../util/TestActorSystem.js';

/**
 * **AGENTS.md's HOCON leaf rule, held to the tree (#1443).**
 *
 * The naming-lockstep paragraph makes two claims about every HOCON leaf, and a
 * sentence about the tree is worth no more than whatever reads it.  The first
 * claim — no leaf is spelled "the other way" any more, camelCase or with the
 * unit suffix the TypeScript field keeps — stood there while 57 leaves under
 * `actor-ts.io.broker.*` were still camelCase, because those readers took
 * literals that no walk of `ConfigKeys` could see and each guard that existed
 * covered one part of the tree.  The second — where a retired spelling is
 * refused — said "at startup", which reads as `ActorSystem.create`, and
 * nothing checks there: each block refuses an old spelling only where it is
 * first read, so one that nothing reads is never refused at all.
 *
 * So this file checks both against the code — "not up front" over every entry
 * of every retired-leaf table `src/` declares, read from the source, since a
 * sample lets a check at `ActorSystem.create` through for every spelling
 * outside it — and pins the paragraph to the
 * same list of refusal sites the behavior tests run, the way
 * `WorkflowHygiene` pins the publish paragraph to the spellings it reads: a
 * change to either side fails here until the other moves with it.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');

/**
 * Generated, never hand-written, and no config reader: the DevTools UI bundle
 * embedded as a string.  Scanned, its minified code could hand a camelCase
 * literal to a method that merely shares a name with a `Config` accessor.
 */
const GENERATED_DIRECTORY = join(SOURCE_ROOT, 'devtools', 'generated');

/** One path segment as the rule spells it: lowercase words joined by `-`. */
const KEBAB_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A time unit the TypeScript field carries and the leaf drops.  `-bytes`
 * stays, as `max-frame-bytes` does: the reader is `getBytes`, which takes
 * `64K` and a bare byte count alike, and the word says what is capped.
 */
const UNIT_SUFFIX = /-(?:ms|millis|milliseconds|seconds|secs|minutes|mins|hours)$/;

/** The segments of a dotted path that break the rule, each with the reason. */
function misspelledSegments(path: string): string[] {
  return path.split('.').flatMap((segment) => {
    if (!KEBAB_SEGMENT.test(segment)) return [`"${segment}" is not kebab-case`];
    if (UNIT_SUFFIX.test(segment)) return [`"${segment}" keeps a unit suffix`];
    return [];
  });
}

/** Every string under `node`, with the accessor trail that reaches it. */
function stringsUnder(node: unknown, trail: string): Array<{ trail: string; value: string }> {
  if (typeof node === 'string') return [{ trail, value: node }];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, child]) => stringsUnder(child, `${trail}.${key}`));
}

/** Every leaf path of a parsed HOCON tree; an array is a leaf. */
function leafPathsOf(node: unknown, prefix: string): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [prefix];
  return Object.entries(node).flatMap(([key, child]) => leafPathsOf(child, prefix === '' ? key : `${prefix}.${key}`));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (path === GENERATED_DIRECTORY) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * A `Config` accessor handed a path written in place — a string or a template
 * literal.  Reading through `ConfigKeys` is the house rule and almost every
 * reader keeps it; this is what catches the ones that do not, which is where
 * the io.broker leaves hid: 114 such calls spelled a segment the old way
 * before #1443, and a walk of the declared keys saw none of them.
 */
const LITERAL_PATH_ACCESS =
  /\.(?:atPath|getBoolean|getBytes|getConfig|getDuration|getInt|getList|getNumber|getObject|getString|getStringList|hasPath)\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;

/** The misspelled literal path reads in `text`; interpolations are not spellings. */
function misspelledLiteralReads(text: string): string[] {
  return [...text.matchAll(LITERAL_PATH_ACCESS)]
    .filter((match) => misspelledSegments(match[2].replace(/\$\{[^}]*\}/g, 'x')).length > 0)
    .map((match) => match[0]);
}

describe('no HOCON leaf is spelled the other way', () => {
  test('every path ConfigKeys declares is kebab-case with no unit suffix', () => {
    const declared = stringsUnder(ConfigKeys, 'ConfigKeys');
    // Not vacuous: the walk reaches the io.broker groups #1443 added.
    expect(declared.filter((key) => key.value.startsWith('actor-ts.io.broker.')).length).toBeGreaterThan(100);
    const problems = declared.flatMap((key) =>
      misspelledSegments(key.value).map((reason) => `${key.trail} = ${key.value}: ${reason}`));
    expect(problems).toEqual([]);
  });

  test('every leaf reference.conf publishes is kebab-case with no unit suffix', () => {
    const leaves = leafPathsOf(parseHocon(REFERENCE_CONF), '');
    expect(leaves.length).toBeGreaterThan(400);
    const problems = leaves.flatMap((leaf) => misspelledSegments(leaf).map((reason) => `${leaf}: ${reason}`));
    expect(problems).toEqual([]);
  });

  /**
   * A block whose root is the caller's — a named cache, a broker subclass's
   * `configKey()` — cannot be declared once, so its leaves are composed under
   * a root by an exported `…KeysUnder` function instead.  Found by name, so a
   * composer added later is checked without being listed here.
   */
  test('every leaf an exported …KeysUnder composer builds is kebab-case with no unit suffix', async () => {
    const composers = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/export function (\w+KeysUnder)\(/g)].map((match) => ({ file, name: match[1] })));
    expect(composers.map((composer) => composer.name)).toEqual(
      expect.arrayContaining(['brokerCommonKeysUnder', 'inMemoryCacheKeysUnder', 'redisCacheKeysUnder']),
    );
    const problems: string[] = [];
    for (const { file, name } of composers) {
      const module = await import(pathToFileURL(file).href) as Record<string, unknown>;
      const compose = module[name] as (root: string) => unknown;
      for (const key of stringsUnder(compose('actor-ts.probe'), name)) {
        problems.push(...misspelledSegments(key.value).map((reason) => `${key.trail} = ${key.value}: ${reason}`));
      }
    }
    expect(problems).toEqual([]);
  });

  test('the literal-path matcher sees a misspelled read, and passes a kebab one', () => {
    // Guards the scan below: a matcher that never matched would pass it.
    expect(misspelledLiteralReads("if (config.hasPath('maxFrameBytes')) out.x = 1;")).toHaveLength(1);
    expect(misspelledLiteralReads('config.getDuration(`${root}.idleTimeoutMs`)')).toHaveLength(1);
    expect(misspelledLiteralReads("config.getDuration(\"actor-ts.x.accept-timeout-ms\")")).toHaveLength(1);
    expect(misspelledLiteralReads("config.getBytes('max-frame-bytes'); config.hasPath(`${root}.ping-interval`)")).toEqual([]);
  });

  test('no Config accessor in src/ is handed a path that spells a segment the old way', () => {
    const problems = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      misspelledLiteralReads(readFileSync(file, 'utf8')).map((read) => `${relative(REPOSITORY_ROOT, file)}: ${read}`));
    expect(problems).toEqual([]);
  });
});

/** What a probe actor's `preStart` came to — written by the actor, read by the test. */
type PreStartReport = { settled: boolean; failure: unknown };

/** An MQTT broker that records its `preStart` failure instead of being supervised for it. */
class PreStartReportingMqttActor extends MqttActor<never> {
  constructor(private readonly report: PreStartReport) { super(); }

  onMessage(): void { /* never reached: option resolution refuses before anything connects */ }

  override async preStart(): Promise<void> {
    try { await super.preStart(); } catch (e) { this.report.failure = e; } finally { this.report.settled = true; }
  }
}

/** The gRPC server, which is no `BrokerActor` and refuses in its own `preStart`. */
class PreStartReportingGrpcServerActor extends GrpcServerActor {
  constructor(private readonly report: PreStartReport) { super(); }

  override async preStart(): Promise<void> {
    try { await super.preStart(); } catch (e) { this.report.failure = e; } finally { this.report.settled = true; }
  }
}

/** Spawn a reporting actor and rethrow whatever its `preStart` failed with. */
async function preStartOf(spawn: (report: PreStartReport) => void): Promise<void> {
  const report: PreStartReport = { settled: false, failure: null };
  spawn(report);
  await awaitCondition(() => report.settled, { timeoutMs: 4_000, label: "the probe actor's preStart settled" });
  if (report.failure !== null) throw report.failure;
}

class SilentWebsocketServer extends WebsocketServerActor<never, never> {
  onMessage(): void { /* nothing connects: bind() is as far as the probe goes */ }
}

/** A backend that opens no socket, so `bind()` costs nothing beyond the route wiring. */
class InertBackend implements HttpServerBackend {
  readonly name = 'inert';
  registerRoute(_route: RouteRegistration): void { /* no request reaches it */ }
  registerWebSocket(_registration: WebsocketRouteRegistration): void { /* no upgrade reaches it */ }
  async listen(host: string, port: number): Promise<ServerBinding> {
    return { host, port, unbind: async () => {} };
  }
}

/** One block, one of its retired spellings, and the place that first reads it. */
type RefusalSite = {
  /** How the AGENTS.md paragraph names the place — verbatim, whitespace collapsed. */
  readonly named: string;
  readonly hocon: string;
  readonly retired: string;
  readonly current: string;
  /** What runs before the first read and has to start regardless. */
  readonly beforeFirstRead?: (system: ActorSystem) => unknown;
  readonly firstRead: (system: ActorSystem) => Promise<unknown>;
};

const REFUSAL_SITES: ReadonlyArray<RefusalSite> = [
  {
    named: "a broker actor's `preStart`",
    hocon: 'actor-ts.io.broker.mqtt.brokerUrl = "mqtt://127.0.0.1:1"',
    retired: 'actor-ts.io.broker.mqtt.brokerUrl',
    current: 'actor-ts.io.broker.mqtt.broker-url',
    firstRead: (system) => preStartOf((report) => {
      system.spawnAnonymous(() => new PreStartReportingMqttActor(report));
    }),
  },
  {
    named: "a gRPC server's start",
    hocon: 'actor-ts.io.broker.grpc.server.protoPath = "service.proto"',
    retired: 'actor-ts.io.broker.grpc.server.protoPath',
    current: 'actor-ts.io.broker.grpc.server.proto-path',
    firstRead: (system) => preStartOf((report) => {
      system.spawnAnonymous(() => new PreStartReportingGrpcServerActor(report));
    }),
  },
  {
    named: 'the first `HttpExtension` access',
    hocon: 'actor-ts.http.client.maxResponseBytes = 1K',
    retired: 'actor-ts.http.client.maxResponseBytes',
    current: 'actor-ts.http.client.max-response-bytes',
    firstRead: async (system) => system.extension(HttpExtensionId),
  },
  {
    named: 'the `bind()` of a server with a WebSocket route',
    hocon: 'actor-ts.http.websocket.maxFrameBytes = 512KiB',
    retired: 'actor-ts.http.websocket.maxFrameBytes',
    current: 'actor-ts.http.websocket.max-frame-bytes',
    beforeFirstRead: (system) => system.extension(HttpExtensionId),
    firstRead: async (system) => {
      const server = system.spawn(SilentWebsocketServer, 'silent') as unknown as WebsocketServerRef<never, never, never>;
      const binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(new InertBackend())
        .bind(websocket('/ws', server));
      await binding.unbind();
    },
  },
  {
    named: '`cache(name)`',
    hocon: 'actor-ts.cache.in-memory.maxEntries = 5',
    retired: 'actor-ts.cache.in-memory.maxEntries',
    current: 'actor-ts.cache.in-memory.max-entries',
    beforeFirstRead: (system) => system.extension(CacheExtensionId),
    firstRead: async (system) => system.extension(CacheExtensionId).cache('orders'),
  },
];

/** A retired-leaf table as `src/` declares it, read off its literal. */
type RetiredTable = {
  readonly name: string;
  readonly file: string;
  readonly entries: Readonly<Record<string, string>>;
};

/** A table's declaration: each is a flat map of string literals, so the first `}` ends it. */
const RETIRED_TABLE_DECLARATION = /\bconst (RETIRED_\w+): RetiredLeaves = \{([^}]*)\};/g;

/** One entry of a table: a quoted or bare key, and the quoted spelling that replaced it. */
const RETIRED_TABLE_ENTRY = /^(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'([^']+)',?$/;

/**
 * Every retired-leaf table `src/` declares.  Most are private to the module
 * whose reader checks them, so they are read from the source rather than
 * imported; the three that are exported are compared with their parse, and so
 * is every broker's own table, so a parser that misreads one fails there.
 */
function retiredTables(): RetiredTable[] {
  return sourceFiles(SOURCE_ROOT).flatMap((file) => {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    return [...text.matchAll(RETIRED_TABLE_DECLARATION)].map((declaration) => {
      const entries: Record<string, string> = {};
      const lines = declaration[2]!.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('//'));
      for (const line of lines) {
        const entry = line.match(RETIRED_TABLE_ENTRY);
        if (entry === null) {
          throw new Error(`${relative(SOURCE_ROOT, file)}: ${declaration[1]} has an entry this test cannot read: ${line}`);
        }
        entries[entry[1] ?? entry[2]!] = entry[3]!;
      }
      return { name: declaration[1]!, file, entries };
    });
  });
}

/** What a running broker actor is asked here: its block root and its own retired table. */
type BrokerPrototype = {
  configKey(): string;
  retiredLeaves(): Readonly<Record<string, string>>;
};

/**
 * Every broker actor class `src/` exports, with its block root and its own
 * table.  Both methods return constants, so a bare prototype answers them as a
 * constructed actor would — no options, no transport.  A class counts when it
 * has both, which `BrokerActor` itself does not: its `configKey` is abstract.
 */
async function brokerBlocks(): Promise<Array<{ readonly name: string; readonly root: string; readonly own: Readonly<Record<string, string>> }>> {
  const blocks: Array<{ readonly name: string; readonly root: string; readonly own: Readonly<Record<string, string>> }> = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    if (!/\bextends BrokerActor\b/.test(readFileSync(file, 'utf8'))) continue;
    const module = await import(pathToFileURL(file).href) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== 'function') continue;
      const prototype = (value as { readonly prototype?: Partial<BrokerPrototype> }).prototype;
      if (typeof prototype?.configKey !== 'function' || typeof prototype.retiredLeaves !== 'function') continue;
      const probe = Object.create(prototype) as BrokerPrototype;
      blocks.push({ name, root: probe.configKey(), own: probe.retiredLeaves() });
    }
  }
  return blocks;
}

/** The two tables `BrokerActor` checks under every broker's root, beside the broker's own. */
const SHARED_BROKER_TABLES = {
  RETIRED_BROKER_COMMON_LEAVES,
  RETIRED_BROKER_CIRCUIT_BREAKER_LEAVES,
} as const;

/**
 * Where each table no broker returns from `retiredLeaves()` is checked: the
 * roots its reader hands `rejectRetiredLeaves`.  The cache's table is checked
 * under a named block as well, which `cache(name)` reads with the default
 * block's reader; `orders` stands for any name.  A table missing here fails
 * the pin below, so a new one has to say where it is checked.
 */
const OTHER_TABLE_ROOTS: Readonly<Record<string, readonly string[]>> = {
  RETIRED_IN_MEMORY_CACHE_LEAVES: [ConfigKeys.cache.inMemoryOptions.root, `${ConfigKeys.cache.root}.orders.in-memory`],
  RETIRED_HTTP_CLIENT_LEAVES: [ConfigKeys.http.client.root],
  RETIRED_WEBSOCKET_LEAVES: [ConfigKeys.http.websocket.root],
  RETIRED_GRPC_SERVER_LEAVES: [ConfigKeys.io.broker.grpc.server.root],
  RETIRED_TCP_FRAMING_LEAVES: [ConfigKeys.io.broker.tcp.framing.root, ConfigKeys.io.broker.tcpServer.framing.root],
};

/**
 * Every retired spelling of every table, at every root it is checked under —
 * each broker's own table and the two shared ones under the broker's root,
 * every other table under the roots above — with the tables it was built
 * from, so the test can say which table it could not place.
 */
async function everyRetiredSpelling(): Promise<{
  readonly paths: readonly string[];
  readonly tables: readonly RetiredTable[];
  readonly placed: ReadonlySet<string>;
}> {
  const tables = retiredTables();
  const tableNamed = (name: string): RetiredTable | undefined => tables.find((table) => table.name === name);
  const placed = new Set<string>(Object.keys(SHARED_BROKER_TABLES));
  const paths: string[] = [];
  for (const { name, root, own } of await brokerBlocks()) {
    const ownTable = tables.find((table) => Bun.deepEquals(table.entries, own, true));
    if (Object.keys(own).length > 0) {
      expect(ownTable, `${name}.retiredLeaves() returns a table no declaration in src/ parses to`).toBeDefined();
      placed.add(ownTable!.name);
    }
    const leaves = { ...RETIRED_BROKER_COMMON_LEAVES, ...RETIRED_BROKER_CIRCUIT_BREAKER_LEAVES, ...own };
    paths.push(...Object.keys(leaves).map((leaf) => `${root}.${leaf}`));
  }
  for (const [name, roots] of Object.entries(OTHER_TABLE_ROOTS)) {
    const table = tableNamed(name);
    expect(table, `${name} is placed here, and src/ declares no such table`).toBeDefined();
    placed.add(name);
    paths.push(...roots.flatMap((root) => Object.keys(table!.entries).map((leaf) => `${root}.${leaf}`)));
  }
  return { paths, tables, placed };
}

/* ----------------------- the renames that moved code too ----------------------- */

/** A source file with its comments removed, so a call a comment shows is not taken for one. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * The top-level arguments between the bracket at `open` and its partner.
 * Strings are skipped, and `=>` closes nothing, so a parameter typed as a
 * function or a generic with two arguments counts once.
 */
function argumentsAt(text: string, open: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let index = open; index < text.length; index++) {
    const character = text[index]!;
    if (quote !== null) {
      if (character === '\\') index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') quote = character;
    else if ('([{<'.includes(character)) depth++;
    else if (')]}'.includes(character) || (character === '>' && text[index - 1] !== '=')) {
      depth--;
      if (depth === 0) {
        parts.push(text.slice(start, index));
        return parts.map((part) => part.trim()).filter((part) => part !== '');
      }
    } else if (character === ',' && depth === 1) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  throw new Error(`unbalanced brackets from offset ${open}`);
}

/** The text of every string literal in `text`, joined: a note built with `+` reads as one. */
function stringLiteralsIn(text: string): string {
  return [...text.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
    .map((literal) => literal[1] ?? literal[2] ?? literal[3] ?? '')
    .join('');
}

/** A table whose refusal says something about code other than the default, and the identifiers its note names. */
type CodeRename = {
  readonly file: string;
  readonly table: string;
  readonly identifiers: readonly string[];
};

/** A TypeScript identifier a note names: a camelCase field, or a builder method. */
const TYPESCRIPT_IDENTIFIER = /\b(?:with[A-Z]\w*|[a-z][a-z0-9]*[A-Z]\w*)\b/g;

/**
 * Every call in `src/` that passes `rejectRetiredLeaves` a note of its own —
 * a rename that moved TypeScript as well, where the default note ("no code
 * change is needed") would be false.  The note is read where the call names
 * it, so what the prose has to name comes from what the refusal says.
 */
function codeRenames(): CodeRename[] {
  return sourceFiles(SOURCE_ROOT).flatMap((file) => {
    const code = codeOf(file);
    return [...code.matchAll(/\brejectRetiredLeaves\(/g)].flatMap((call): CodeRename[] => {
      if (/\bfunction\s+$/.test(code.slice(Math.max(0, call.index! - 20), call.index!))) return [];
      const parts = argumentsAt(code, call.index! + call[0].length - 1);
      if (parts.length < 4) return [];
      const note = parts[3]!;
      let text: string;
      if (/^['"`]/.test(note)) {
        text = stringLiteralsIn(note);
      } else {
        const declaration = code.match(new RegExp(`\\bconst ${note}\\s*(?::[^=]+)?=([\\s\\S]*?);\\n`));
        if (declaration === null) throw new Error(`${relative(SOURCE_ROOT, file)}: the note ${note} is no const this test can read`);
        text = stringLiteralsIn(declaration[1]!);
      }
      return [{ file, table: parts[2]!, identifiers: [...new Set(text.match(TYPESCRIPT_IDENTIFIER) ?? [])] }];
    });
  });
}

/** The renames none of `text`'s code spans names: a span counts when it is one of the note's identifiers, or calls one. */
function unnamedRenames(text: string, renames: readonly CodeRename[]): string[] {
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((span) => span[1]!);
  return renames
    .filter((rename) => !rename.identifiers.some((identifier) =>
      spans.some((span) => span === identifier || span.startsWith(`${identifier}(`))))
    .map((rename) => rename.table);
}

/**
 * A claim that one table is the exception — the shape the sentence about code
 * notes went stale in — or the plain denial that any table passes a note.
 */
const SINGLE_EXCEPTION_CLAIM =
  /\b(?:the )?(?:one|only|single) (?:rename|table)\b|\bevery table is but\b|\b(?:gets?|pass(?:es)?) no note\b|\bno table passes\b/i;

/** Every builder method `src/` declares, by name, with the parameter counts its declarations take. */
function builderArities(): Map<string, Set<number>> {
  const arities = new Map<string, Set<number>>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const code = codeOf(file);
    for (const declaration of code.matchAll(/(?:^|\n)[ \t]*(?:(?:public|protected|override)\s+)*(with[A-Z]\w*)\(/g)) {
      const name = declaration[1]!;
      const arity = argumentsAt(code, declaration.index! + declaration[0].length - 1).length;
      arities.set(name, (arities.get(name) ?? new Set<number>()).add(arity));
    }
  }
  return arities;
}

/** A passage's sentences, as a reader splits them. */
function sentencesOf(passage: string): string[] {
  return passage.split(/(?<=[.!?])\s+(?=[A-Z*`])/);
}

/** The comment `src/config/RetiredKeys.ts` gives the default note, which says which tables need another. */
function defaultNoteComment(): string {
  const text = readFileSync(join(SOURCE_ROOT, 'config', 'RetiredKeys.ts'), 'utf8').replace(/\r\n/g, '\n');
  const comment = text.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*const HOCON_ONLY_RENAME_NOTE\b/);
  expect(comment, 'RetiredKeys.ts lost the comment on HOCON_ONLY_RENAME_NOTE').not.toBeNull();
  return comment![1]!.replace(/^\s*\* ?/gm, '').replace(/\s+/g, ' ').trim();
}

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

describe('a retired spelling is refused where its block is first read', () => {
  test.each([...REFUSAL_SITES])('$retired starts the system, and $named refuses it', async (site) => {
    const system = createTestActorSystem({ name: 'hocon-leaf-spelling', config: Config.parseString(site.hocon) });
    try {
      site.beforeFirstRead?.(system);
      const refusal = await errorOf(() => site.firstRead(system));
      expect(refusal).toBeInstanceOf(ConfigError);
      expect((refusal as ConfigError).message).toContain(`${site.retired} has been renamed to ${site.current}`);
    } finally {
      await system.terminate();
    }
  });

  test('every retired-leaf table src/ declares is read as declared', () => {
    const tables = retiredTables();
    const parsed = new Map(tables.map((table) => [table.name, table.entries]));
    // The exported tables are the parser's check: a misread one differs from its import.
    const exported = { ...SHARED_BROKER_TABLES, RETIRED_TCP_FRAMING_LEAVES };
    for (const [name, table] of Object.entries(exported)) {
      expect(parsed.get(name), `${name} as parsed from src/`).toEqual({ ...table });
    }
    expect(parsed.size, 'two tables share a name').toBe(tables.length);
    for (const table of tables) {
      expect(Object.keys(table.entries).length, `${table.name} parsed to no entries`).toBeGreaterThan(0);
    }
  });

  test('nothing checks up front: a system holding every retired spelling of every table at once starts', async () => {
    // Every entry of every table at every root it is checked under, not a
    // sample: a check at ActorSystem.create that refused any one of them
    // would fail here, where a check of a spelling outside a sample would not.
    const { paths, tables, placed } = await everyRetiredSpelling();
    expect(
      tables.map((table) => table.name).filter((name) => !placed.has(name)),
      'a retired-leaf table this test does not place under the root it is checked at',
    ).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining(REFUSAL_SITES.map((site) => site.retired)));
    // Guards the guard: the shared tables sit under every broker's root, and
    // the cache's table under a named block too — the two parts a shorter
    // list would drop, and with them a check of those spellings at create.
    const brokers = await brokerBlocks();
    expect(brokers.length).toBeGreaterThan(10);
    for (const { root } of brokers) {
      for (const shared of Object.values(SHARED_BROKER_TABLES)) {
        expect(paths).toEqual(expect.arrayContaining(Object.keys(shared).map((leaf) => `${root}.${leaf}`)));
      }
    }
    expect(paths.filter((path) => path.startsWith(`${ConfigKeys.cache.root}.orders.in-memory.`)).length).toBeGreaterThan(0);

    const hocon = paths.map((path) => `${path} = 1`).join('\n');
    const system = createTestActorSystem({ name: 'hocon-leaf-spelling-all', config: Config.parseString(hocon) });
    try {
      for (const path of paths) expect(system.config.hasPath(path), `${path} did not reach the system config`).toBe(true);
    } finally {
      await system.terminate();
    }
  });
});

describe('the AGENTS.md naming-lockstep paragraph says so', () => {
  /**
   * The paragraph as a reader sees it: HTML comments render nothing, so they
   * are dropped before anything is matched, and line breaks are whitespace.
   */
  function lockstepParagraph(): string {
    const rendered = readFileSync(join(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const start = rendered.indexOf('Naming lockstep with **no divergence**');
    expect(start, 'AGENTS.md lost the naming-lockstep paragraph this file pins').toBeGreaterThan(-1);
    // Ends at the next top-level bullet, bold or not; without one the slice
    // would run to the end of the file and find the claims anywhere at all.
    const length = rendered.slice(start).search(/\n- /);
    expect(length, 'the naming-lockstep paragraph is no longer followed by a bullet').toBeGreaterThan(0);
    return rendered.slice(start, start + length).replace(/\s+/g, ' ');
  }

  test('credits #1443 beside #1405 for converting the last leaves', () => {
    expect(lockstepParagraph()).toMatch(/#1405 and #1443 converted the last leaves that spelled it the other way/);
  });

  test('names every place a retired spelling is refused, and not ActorSystem.create', () => {
    const paragraph = lockstepParagraph();
    for (const site of REFUSAL_SITES) expect(paragraph).toContain(site.named);
    expect(paragraph).toMatch(/where its block is first read/);
    expect(paragraph).toMatch(/not up front at `ActorSystem\.create`/);
    expect(paragraph).not.toMatch(/refused at startup/);
  });

  test('every rename whose refusal says what changed in code is found, with what its note names', () => {
    // Guards the guard: the two tables that pass a note of their own today.
    const renames = codeRenames();
    expect(renames.map((rename) => rename.table)).toEqual(expect.arrayContaining([
      'RETIRED_BROKER_CIRCUIT_BREAKER_LEAVES',
      'RETIRED_TCP_FRAMING_LEAVES',
    ]));
    for (const rename of renames) {
      expect(rename.identifiers.length, `${rename.table}'s note names no TypeScript field or method`).toBeGreaterThan(0);
    }
  });

  test('where it names rejectRetiredLeaves, it names every rename that moved code, and none as the only one', () => {
    // The sentence said the TCP framing caps were the one rename that moved
    // TypeScript fields after the broker breaker's had moved too, with its
    // own note.  Each note-passing table is named by a field or method its
    // note names, so the next one fails here until the sentence takes it.
    const paragraph = lockstepParagraph();
    const sentence = sentencesOf(paragraph).find((candidate) => candidate.includes('`rejectRetiredLeaves`'));
    expect(sentence, 'the paragraph no longer says which tables pass rejectRetiredLeaves a note').toBeDefined();
    expect(unnamedRenames(sentence!, codeRenames()), 'renames whose refusal says code moved, which the sentence leaves out')
      .toEqual([]);
    expect(paragraph).not.toMatch(SINGLE_EXCEPTION_CLAIM);
  });

  test('every builder call it shows is one src/ declares with that many parameters', () => {
    // `withCircuitBreaker(f, r)` stood here after the breaker had become an
    // id and the method `withCircuitBreaker(id)`.
    const calls = [...lockstepParagraph().matchAll(/`(with[A-Z]\w*)\(([^)`]*)\)`/g)];
    expect(calls.length).toBeGreaterThan(0);
    const arities = builderArities();
    for (const [, name, parameters] of calls) {
      const arity = parameters!.trim() === '' ? 0 : parameters!.split(',').length;
      expect([...(arities.get(name!) ?? [])], `\`${name}(${parameters})\`: no builder in src/ declares ${name} with ${arity}`)
        .toContain(arity);
    }
  });

  test("RetiredKeys.ts's comment on the default note names every rename that moved code, and none as the only one", () => {
    const comment = defaultNoteComment();
    expect(unnamedRenames(comment, codeRenames()), 'renames whose refusal says code moved, which the comment leaves out')
      .toEqual([]);
    expect(comment).not.toMatch(SINGLE_EXCEPTION_CLAIM);
  });
});
