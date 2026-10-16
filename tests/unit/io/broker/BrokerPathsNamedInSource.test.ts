import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import { brokerCommonKeysUnder } from '../../../../src/io/broker/BrokerOptions.js';

/**
 * **Every `actor-ts.io.broker.…` path the source names is one the framework
 * reads.**
 *
 * The broker files name their HOCON blocks in prose — each options builder's
 * header says which root the HOCON layer of its merge is read from — and an
 * operator copies that spelling into an application.conf.  Nothing else holds
 * the prose to `ConfigKeys`, and this package has no unknown-key detection, so
 * a stale spelling costs a block that nothing reads and nothing reports:
 * `RedisStreamsOptions.ts` named the Redis Streams root by its `ConfigKeys`
 * accessor, `redisStreams`, from the day it was written, while every reader
 * read `redis-streams` (#1443).
 *
 * A named path counts when `ConfigKeys.io.broker` declares it, or when it is
 * one of the leaves every broker block shares, which `brokerCommonKeysUnder`
 * composes under each root instead of `ConfigKeys` listing them per broker.
 * `ConfigKeys.ts` is not scanned: it is where the paths are declared, and its
 * header misspells one on purpose, to show what the typed tree is for.
 *
 * What this cannot see: a path broken across two lines, one assembled from an
 * interpolation, and a real path named in the wrong place — a file that names
 * another block's root passes, because the path exists.  For the header of
 * each options builder, `BrokerConfigCompleteness.test.ts` checks that too.
 */

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'src');

/** Where the paths are declared, relative to `src/`. */
const DECLARING_FILE = 'config/ConfigKeys.ts';

/**
 * A dotted path below `actor-ts.io.broker`, at least one segment deep.  A
 * segment takes either case and underscores, so a camelCase or snake_case
 * spelling is matched whole rather than cut short at its first capital; a
 * placeholder (`<name>`) or an interpolation (`${root}`) ends the path before
 * it has a segment, so neither is matched at all.
 */
const BROKER_PATH = /actor-ts\.io\.broker(?:\.[A-Za-z0-9_-]+)+/g;

type NamedPath = { readonly path: string; readonly line: number };

/** Each broker path `text` names, with the line it is on. */
function pathsNamedIn(text: string): ReadonlyArray<NamedPath> {
  const out: NamedPath[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(BROKER_PATH)) out.push({ path: match[0], line: index + 1 });
  }
  return out;
}

type KeyTree = { readonly [accessor: string]: string | KeyTree };

/** Every path in a group of keys, at any depth. */
function pathsOf(keys: KeyTree): string[] {
  return Object.values(keys).flatMap((value) => (typeof value === 'string' ? [value] : pathsOf(value)));
}

const brokerKeys = ConfigKeys.io.broker as unknown as KeyTree;

/**
 * The root of every block a `BrokerActor` reads.  Each entry under
 * `io.broker` is one, except `grpc`, which only groups the gRPC client's block
 * with the server's — and the server is a plain actor that shares none of the
 * common leaves (see its `ConfigKeys` entry).
 */
const BROKER_ROOTS: ReadonlyArray<string> = [
  ...Object.entries(brokerKeys)
    .filter(([accessor]) => accessor !== 'grpc')
    .map(([, block]) => (block as KeyTree)['root'] as string),
  ConfigKeys.io.broker.grpc.client.root,
];

/** Every path the framework reads under `actor-ts.io.broker`. */
const READ_PATHS: ReadonlySet<string> = new Set([
  ...pathsOf(brokerKeys),
  ...BROKER_ROOTS.flatMap((root) => pathsOf(brokerCommonKeysUnder(root) as unknown as KeyTree)),
]);

/** Every `.ts` file under `src/`, relative to it, with forward slashes. */
const SOURCE_FILES: ReadonlyArray<string> = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => file.endsWith('.ts'))
  .sort();

const NAMED: ReadonlyArray<NamedPath & { readonly file: string }> = SOURCE_FILES
  .filter((file) => file !== DECLARING_FILE)
  .flatMap((file) => pathsNamedIn(readFileSync(join(SOURCE_ROOT, file), 'utf8')).map((named) => ({ ...named, file })));

describe('every actor-ts.io.broker path the source names is one the framework reads', () => {
  test('the scan matches a path whole, in any spelling, and nothing that is not one', () => {
    // Guards the guard: a pattern that matched nothing would pass every file.
    expect(pathsNamedIn(' * `actor-ts.io.broker.redisStreams` > built-in defaults).'))
      .toEqual([{ path: 'actor-ts.io.broker.redisStreams', line: 1 }]);
    expect(pathsNamedIn('a\r\nunder actor-ts.io.broker.mqtt.broker_url.\r\n'))
      .toEqual([{ path: 'actor-ts.io.broker.mqtt.broker_url', line: 2 }]);
    expect(pathsNamedIn("const root = 'actor-ts.io.broker.tcp-server.framing.max-frame-bytes';"))
      .toEqual([{ path: 'actor-ts.io.broker.tcp-server.framing.max-frame-bytes', line: 1 }]);
    expect(pathsNamedIn('`actor-ts.io.broker.<name>`, `actor-ts.io.broker.${name}`, actor-ts.io.broker.')).toEqual([]);
  });

  test('the paths it counts as read include a declared leaf and a composed one, and no retired spelling', () => {
    expect(READ_PATHS.has(ConfigKeys.io.broker.redisStreams.root)).toBe(true);
    expect(READ_PATHS.has(ConfigKeys.io.broker.tcpServer.framing.maxFrameBytes)).toBe(true);
    expect(READ_PATHS.has('actor-ts.io.broker.kafka.circuit-breaker')).toBe(true);
    expect(READ_PATHS.has('actor-ts.io.broker.redisStreams')).toBe(false);
    expect(READ_PATHS.has('actor-ts.io.broker.tcp.framing.maxLineLen')).toBe(false);
    expect(READ_PATHS.has('actor-ts.io.broker.grpc.server.reconnect')).toBe(false);
  });

  test('the scan reaches the broker files', () => {
    // A scan that found no file, or no path in one, would pass vacuously.
    const files = new Set(NAMED.map((named) => named.file));
    expect(files.has('io/broker/RedisStreamsOptions.ts')).toBe(true);
    expect(files.has('io/broker/TcpServerActor.ts')).toBe(true);
    expect(files.has('http/websocket/WebsocketClientOptions.ts')).toBe(true);
  });

  test('no source file names a path nothing reads', () => {
    const unread = NAMED
      .filter((named) => !READ_PATHS.has(named.path))
      .map((named) => `src/${named.file}:${named.line}: ${named.path}`);
    expect(
      unread,
      'each of these is spelled differently from every path ConfigKeys.io.broker declares and every shared '
      + 'leaf brokerCommonKeysUnder composes, so an operator who copies it gets a block nothing reads, with no '
      + 'error.  Name the path as its reader reads it.',
    ).toEqual([]);
  });
});
