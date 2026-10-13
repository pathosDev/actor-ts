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
import { GrpcServerActor } from '../../../src/io/broker/GrpcServerActor.js';
import { MqttActor } from '../../../src/io/broker/MqttActor.js';
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
 * So this file checks both against the code, and pins the paragraph to the
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

  test('nothing checks up front: a system holding every one of them at once starts', async () => {
    const hocon = REFUSAL_SITES.map((site) => site.hocon).join('\n');
    const system = createTestActorSystem({ name: 'hocon-leaf-spelling-all', config: Config.parseString(hocon) });
    await system.terminate();
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
});
