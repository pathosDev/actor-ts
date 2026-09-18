import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterRouter } from '../../../src/cluster/router/ClusterRouter.js';
import { ClusterRouterOptions } from '../../../src/cluster/router/ClusterRouterOptions.js';
import { ClusterMailboxDepthAgent } from '../../../src/cluster/router/MailboxDepthAgent.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { ParallelismExtensionId } from '../../../src/parallelism/ParallelismExtension.js';
import { ParallelismOptions } from '../../../src/parallelism/ParallelismOptions.js';
import { AskTimeoutError } from '../../../src/SystemMessages.js';
import type { ModuleImporter } from '../../../src/worker/WorkerMeshBootstrap.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { FakeWorkerBackend, hostMeshNode } from '../worker/__fixtures__/InMemoryWorkerThread.js';
import type { EncodeCommand, EncodedFrame } from './__fixtures__/encoders.js';

/**
 * The stateless-worker recipe (#170): N identical actors, one per worker
 * thread, behind **one local address** — a `ClusterRouter` group on the main
 * thread over the `/user/encoder` each worker's actor module `setup` spawns.
 * No sugar was built for it; this suite is what makes it a recipe rather than
 * a suggestion.
 *
 * On the in-process rig (#1562): every "worker" is a `FakeWorker` hosting a
 * real mesh node through `hostMeshNode`, so the bootstrap, the module import,
 * `setup`, the cluster membership the router derives its routees from and the
 * remote refs it routes through all run — on this thread, with no OS thread
 * anywhere.  The same recipe was run on three real threads (Bun 1.4.2) when
 * the issue was triaged; the thread itself is #1186's question.
 *
 * The last test holds the routing docs to this file: the two fences the recipe
 * is printed as, in both languages, are the module and the block below,
 * byte for byte.
 */

const ENCODERS = new URL('./__fixtures__/encoders.ts', import.meta.url);
const WORKERS = 3;
const WORKER_ROLE = 'compute';
/**
 * The cap on the one ask that must time out — the main thread's share of a
 * roleless router's traffic.  Nothing ever answers it, so this is how long the
 * test waits for a certainty, not a budget for work: the asks that pay a real
 * round trip run under the default ask timeout.
 */
const DROPPED_ASK_TIMEOUT_MS = 500;
const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const OVERVIEW_PAGES = {
  en: join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs', 'routing', 'overview.mdx'),
  de: join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs', 'de', 'routing', 'overview.mdx'),
} as const;

const realImport: ModuleImporter = (href) => import(href) as Promise<Record<string, unknown>>;

type Rig = {
  readonly system: ActorSystem;
  /** The nodes the fake workers host, in spawn order. */
  readonly hosted: Array<Promise<{ readonly system: ActorSystem; readonly cluster: Cluster }>>;
};

/** Keeps the main system's `warn` lines, for the test that reads what a dropped message says. */
class WarningRecorder implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: string[] = [];
  debug(): void { /* below the level */ }
  info(): void { /* below the level */ }
  warn(message: string): void { this.warnings.push(message); }
  error(message: string): void { this.warnings.push(message); }
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }
}

/**
 * The recipe's configuration, as HOCON where the recipe uses HOCON: the
 * workers carry the role the router selects on, and `offload` is kept off the
 * router's own path — the router is a factory, and a factory cannot cross a
 * thread.  Only what the rig needs is on the builder: the module, the count,
 * and the fake backend.
 */
function rig(logger: Logger = new NoopLogger()): Rig {
  const hosted: Rig['hosted'] = [];
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hosted.push(hostMeshNode(worker, realImport).node); } });
  const parallelism = ParallelismOptions.create()
    .withModule(ENCODERS)
    .withWorkers(WORKERS)
    .withBackend(backend);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(logger.level)
    .withConfig({
      'actor-ts': {
        cluster: { 'gossip-interval': '25ms' },
        parallelism: { offload: ['/user/offloaded-*'] },
        'worker-mesh': { 'worker-roles': [WORKER_ROLE] },
      },
    })
    .withParallelism(parallelism);
  return { system: ActorSystem.create('media', systemOptions), hosted };
}

type Encoders = { ask<T>(message: { kind: 'encode'; frame: Uint8Array }, timeoutMs?: number): Promise<T> };

const encode = (router: Encoders, timeoutMs?: number): Promise<EncodedFrame> =>
  router.ask<EncodedFrame>({ kind: 'encode', frame: new Uint8Array(16) }, timeoutMs);

const sortedAddresses = (system: ActorSystem): string[] =>
  system.extension(ParallelismExtensionId).workerMesh!.addresses.map((address) => address.toString()).sort();

/** The main thread's own node — joined by the mesh, so present once `whenReady()` has resolved. */
const mainCluster = (system: ActorSystem): Cluster => system.cluster.toNullable()!;

describe('a ClusterRouter over the worker mesh — one routee per worker, one local address (#170)', () => {
  test('a role-filtered round-robin router answers 3·N asks from exactly the N workers, in address order, and the system terminates', async () => {
    const { system } = rig();
    let terminated = false;
    try {
      // recipe:start
      const parallelism = system.extension(ParallelismExtensionId);
      await parallelism.whenReady();

      const clusterRouterOptions = ClusterRouterOptions.create<EncodeCommand>()
        .withCluster(parallelism.workerMesh!.cluster)
        .withRouterType('round-robin')
        .withRouteePath('/user/encoder')
        .withRole('compute');
      const encoders = system.spawn(ClusterRouter.factory(clusterRouterOptions), 'encoders');
      // recipe:end

      const workers = sortedAddresses(system);
      expect(workers).toHaveLength(WORKERS);
      const replies: EncodedFrame[] = [];
      for (let i = 0; i < 3 * WORKERS; i++) replies.push(await encode(encoders));

      expect(replies.every((reply) => reply.bytes === 16)).toBe(true);
      expect([...new Set(replies.map((reply) => reply.encodedOn))].sort()).toEqual(workers);
      // Round-robin over routees sorted by address: the order is the sorted
      // list, three times over, and it is stable — nothing shuffles between asks.
      expect(replies.map((reply) => reply.encodedOn)).toEqual([...workers, ...workers, ...workers]);
      // The router lives here; its routees do not.
      expect(system._inspectTree().some((cell) => cell.path === 'actor-ts://media/user/encoders')).toBe(true);
      expect(system._inspectTree().some((cell) => cell.path === 'actor-ts://media/user/encoder')).toBe(false);

      await system.terminate();
      terminated = true;
    } finally {
      if (!terminated) await system.terminate();
    }
  }, 20_000);

  test('every worker serves mailbox depths from setup(), so smallest-mailbox routes on readings and not only on the rotation fallback', async () => {
    const { system, hosted } = rig();
    try {
      await system.extension(ParallelismExtensionId).whenReady();
      expect(hosted).toHaveLength(WORKERS);
      for (const node of hosted) expect(ClusterMailboxDepthAgent._isServing((await node).cluster)).toBe(true);
      // Nothing on the main thread asked for depths yet — a router does that
      // for its own node when it needs them.
      expect(ClusterMailboxDepthAgent._isServing(mainCluster(system))).toBe(false);
    } finally {
      await system.terminate();
    }
  }, 20_000);

  /**
   * The trap the recipe's `role` exists for.  Without it the router's own
   * node is a routee like any other, and the main thread has no
   * `/user/encoder`: that share of the traffic is dropped where it arrives,
   * with the cluster's one warning per message, and an `ask` for it times out.
   *
   * Which ask that is, is known, not discovered: routees are sorted by the
   * string form of their address, `media@main:1` sorts before every
   * `media@worker:N`, and the rotation starts at zero — so the **first** ask
   * is the main thread's share.  It is the one ask that carries an explicit
   * timeout, because its timeout is the assertion.  The N that must succeed
   * cross the mesh under the default ask timeout: a fixed cap on a real round
   * trip is the wall-clock-over-work shape that goes red under whole-suite
   * `--parallel` (#1282), and until this rewrite every ask here carried one.
   */
  test('without a role the main thread is a routee too, and its share is dropped with a warning', async () => {
    const logger = new WarningRecorder();
    const { system } = rig(logger);
    try {
      const parallelism = system.extension(ParallelismExtensionId);
      await parallelism.whenReady();
      const roleless = ClusterRouterOptions.create<EncodeCommand>()
        .withCluster(parallelism.workerMesh!.cluster)
        .withRouterType('round-robin')
        .withRouteePath('/user/encoder');
      const encoders = system.spawn(ClusterRouter.factory(roleless), 'encoders');

      let mainThreadShare: unknown;
      try {
        mainThreadShare = `answered by ${(await encode(encoders, DROPPED_ASK_TIMEOUT_MS)).encodedOn}`;
      } catch (error) {
        mainThreadShare = error;
      }
      expect(mainThreadShare).toBeInstanceOf(AskTimeoutError);

      const answered: string[] = [];
      for (let i = 0; i < WORKERS; i++) answered.push((await encode(encoders)).encodedOn);
      expect(answered.sort()).toEqual(sortedAddresses(system));

      // The drop is logged where the envelope lands, on the main node's own
      // inbound path — a hop this thread's ask never waited on, so the line is
      // awaited rather than assumed to precede the timeout.
      const dropped = (): string[] =>
        logger.warnings.filter((line) => line.includes('dropping message to actor-ts://media/user/encoder'));
      await awaitCondition(() => dropped().length === 1, {
        timeoutMs: 4_000, label: 'the main thread warned exactly once about its dropped share',
      });
      expect(dropped()[0]).toContain('no envelope handler registered');
    } finally {
      await system.terminate();
    }
  }, 20_000);

  /**
   * The docs print the recipe this suite runs, byte for byte, in both languages.
   *
   * The `actors.ts` fence is the fixture module from its first `export` on —
   * only the import paths differ, `actor-ts` there and `src/` here.  The
   * `main.ts` fence carries the block between the two markers above, from
   * the extension lookup to the spawn.  A reader who copies the page gets the
   * lines this file has run; an edit to either side that is not mirrored on
   * the other turns this red.
   */
  test('the routing docs print this recipe, and EN and DE print the same code', () => {
    const fixture = readFileSync(fileURLToPath(ENCODERS), 'utf8').replace(/\r\n/g, '\n');
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const moduleBlock = fixture.slice(fixture.indexOf('export type EncodeCommand')).trimEnd();
    const routerBlock = blockBetweenMarkers(self);

    const fences = { en: recipeFencesOf(OVERVIEW_PAGES.en), de: recipeFencesOf(OVERVIEW_PAGES.de) };
    expect(fences.en.module).toBe(fences.de.module);
    expect(fences.en.main).toBe(fences.de.main);
    expect(fences.en.module.slice(fences.en.module.indexOf('export type EncodeCommand')).trimEnd()).toBe(moduleBlock);
    expect(fences.en.main).toContain(routerBlock);
  });
});

/** The lines between `// recipe:start` and `// recipe:end`, with the test body's indentation removed. */
function blockBetweenMarkers(source: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.includes('// recipe:start'));
  const end = lines.findIndex((line) => line.includes('// recipe:end'));
  if (start < 0 || end < 0 || end <= start) throw new Error('recipe markers not found');
  const indent = /^\s*/.exec(lines[start]!)![0].length;
  return lines.slice(start + 1, end).map((line) => line.slice(indent)).join('\n');
}

/** The two recipe fences of a routing overview page, found by the file comment each opens with. */
function recipeFencesOf(page: string): { module: string; main: string } {
  const source = readFileSync(page, 'utf8').replace(/\r\n/g, '\n');
  const fences = [...source.matchAll(/^```ts[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]!);
  const module = fences.find((fence) => fence.startsWith('// actors.ts'));
  const main = fences.find((fence) => fence.startsWith('// main.ts'));
  if (module === undefined || main === undefined) throw new Error(`${page}: the recipe fences are missing`);
  return { module, main };
}
