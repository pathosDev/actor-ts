/**
 * Chat backend entry point.
 *
 * Run a 3-node TCP cluster locally:
 *
 *   bun examples/chat/backend/main.ts --port 2551 --http-port 8081 --seeds localhost:2551
 *   bun examples/chat/backend/main.ts --port 2552 --http-port 8082 --seeds localhost:2551
 *   bun examples/chat/backend/main.ts --port 2553 --http-port 8083 --seeds localhost:2551
 *
 * Open `http://localhost:8081/`, pick a frontend, log in.  See
 * `README.md` for the complete walkthrough.
 *
 * `main.ts` is purely wiring — every actor lives in its own file
 * under `actors/`, every Fastify-specific bit lives in `plugins/`,
 * the directive DSL routes live in `routes.ts`.  Nothing here
 * imports `fastify` directly; everything goes through
 * `HttpExtension` + `FastifyBackend.withPlugin(...)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ActorSystem,
  Cluster,
  ClusterSharding,
  LogLevel,
  MemberDown,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  PersistenceExtensionId,
  Props,
  SqliteJournal,
} from '../../../src/index.js';
import { HttpExtensionId } from '../../../src/http/index.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { DistributedDataId } from '../../../src/crdt/index.js';
import { DistributedPubSubId } from '../../../src/cluster/pubsub/index.js';
import { parseArgs } from './config.js';
import { buildRoutes } from './routes.js';
import { registerStaticFiles } from './plugins/staticFilesPlugin.js';
import {
  registerWebSocketSupport,
  webSocketRoutePlugin,
} from './plugins/webSocketPlugin.js';
import {
  ChatRoomActor,
  type ChatRoomCmd,
} from './actors/ChatRoomActor.js';
import { OnlineUsersActor } from './actors/OnlineUsersActor.js';

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  // -------- 1. ActorSystem --------
  const system = ActorSystem.create('chat-cluster', {
    logLevel: LogLevel.Info,
  });
  system.log.info(
    `chat node starting · cluster=${cfg.host}:${cfg.port} · http=${cfg.host}:${cfg.httpPort}`,
  );

  // -------- 2. Persistence: SQLite journal under data-dir --------
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const journalPath = path.join(cfg.dataDir, 'chat.db');
  const journal = new SqliteJournal({ path: journalPath, wal: true });
  system.extension(PersistenceExtensionId).setJournal(journal);
  system.log.info(`SQLite journal · ${journalPath}`);

  // -------- 3. Cluster --------
  const cluster = await Cluster.join(system, {
    host: cfg.host,
    port: cfg.port,
    seeds: [...cfg.seeds],
    failureDetector: {
      heartbeatIntervalMs: 300,
      unreachableAfterMs: 1500,
      downAfterMs: 4000,
    },
    gossipIntervalMs: 500,
  });
  cluster.subscribe((evt) => {
    if (evt instanceof MemberUp)
      system.log.info(`[+] ${evt.member.address} is UP`);
    else if (evt instanceof MemberUnreachable)
      system.log.warn(`[?] ${evt.member.address} unreachable`);
    else if (evt instanceof MemberDown)
      system.log.warn(`[x] ${evt.member.address} marked DOWN`);
    else if (evt instanceof MemberRemoved)
      system.log.warn(`[-] ${evt.member.address} removed`);
  });

  // -------- 4. DistributedData (presence) + DistributedPubSub (broadcast) --------
  system.extension(DistributedDataId).start(cluster, { gossipIntervalMs: 500 });
  const mediator = system.extension(DistributedPubSubId).start(cluster, {
    gossipIntervalMs: 500,
  });

  // -------- 5. ClusterSharding: one ChatRoomActor per room --------
  const sharding = ClusterSharding.get(system, cluster);
  const chatRoomRegion = sharding.start<ChatRoomCmd>({
    typeName: 'ChatRoom',
    entityProps: Props.create(() => new ChatRoomActor()),
    extractEntityId: (msg) => msg.room,
    numShards: 16,
  });

  // -------- 6. OnlineUsersActor (top-level) --------
  const onlineUsers = system.actorOf(
    Props.create(() => new OnlineUsersActor()),
    'online-users',
  );

  // -------- 7. HTTP backend with static + ws plugins --------
  const staticDir = path.join(import.meta.dirname ?? __dirname, '..', 'static');
  const backend = new FastifyBackend();
  await registerStaticFiles(backend, { root: staticDir, prefix: '/static/' });
  // Two-stage WS registration — see `webSocketPlugin.ts` for why.
  await registerWebSocketSupport(backend);
  await backend.withPlugin(webSocketRoutePlugin, {
    system,
    chatRoomRegion,
    onlineUsers,
    mediator,
  });

  const http = system.extension(HttpExtensionId);
  const binding = await http
    .newServerAt(cfg.host, cfg.httpPort)
    .useBackend(backend)
    .bind(buildRoutes());
  system.log.info(
    `chat HTTP server listening on http://${binding.host}:${binding.port}/`,
  );

  // -------- 8. Graceful shutdown --------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    system.log.info(`received ${signal} — shutting down`);
    try {
      await binding.unbind();
      await cluster.leave();
      await journal.close();
      await system.terminate();
    } catch (e) {
      system.log.warn(`shutdown error: ${(e as Error).message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`chat backend failed to start: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
