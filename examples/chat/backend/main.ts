/**
 * Chat backend entry point.
 *
 * Run a 3-node TCP cluster locally — every node runs the same
 * binary; the cluster picks one to host the HTTP front door:
 *
 *   bun examples/chat/backend/main.ts --port 2551
 *   bun examples/chat/backend/main.ts --port 2552 --seeds localhost:2551
 *   bun examples/chat/backend/main.ts --port 2553 --seeds localhost:2551
 *
 * Open `http://localhost:8080/`, pick a frontend, log in.  See
 * `README.md` for the complete walkthrough — including how
 * failover works when you kill the node currently holding the
 * HTTP singleton.
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
  ClusterSingletonId,
  LogLevel,
  MemberDown,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  PersistenceExtensionId,
  Props,
  SqliteJournal,
} from '../../../src/index.js';
import { DistributedDataId } from '../../../src/crdt/index.js';
import { DistributedPubSubId } from '../../../src/cluster/pubsub/index.js';
import {
  parseArgs,
  BASE_CLUSTER_PORT,
  MAX_NODE_SLOTS,
} from './config.js';
import {
  SameHostScanSeedProvider,
  pickFirstFreePort,
} from './discovery/sameHostScan.js';
import { SessionStore } from './auth/sessionStore.js';
import {
  ChatRoomActor,
  type ChatRoomCmd,
} from './actors/ChatRoomActor.js';
import { OnlineUsersActor } from './actors/OnlineUsersActor.js';
import { httpIngressProps } from './actors/HttpIngressActor.js';

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const SYSTEM_NAME = 'chat-cluster';

  // -------- 1. Cluster discovery --------
  // For local 3-terminal demos with no `--port` / `--seeds` flags,
  // use SameHostScanSeedProvider — same shape as the framework's
  // ConfigSeedProvider / DnsSeedProvider / KubernetesApiSeedProvider,
  // but with a port-scan backend that fits the no-config use case.
  // Anything the user passed explicitly wins.
  const seedProvider = new SameHostScanSeedProvider({
    systemName: SYSTEM_NAME,
    host: cfg.host,
    basePort: BASE_CLUSTER_PORT,
    maxSlots: MAX_NODE_SLOTS,
  });
  const port = cfg.port ?? await pickFirstFreePort({
    host: cfg.host,
    basePort: BASE_CLUSTER_PORT,
    maxSlots: MAX_NODE_SLOTS,
  });
  const seeds = cfg.seeds !== null
    ? [...cfg.seeds]
    : (await seedProvider.lookup())
        // Don't seed ourselves: the scan ran before we bound `port`,
        // but the user-passed port (or the picked port) might still
        // be a no-op address.  Filter for cleanliness.
        .filter((a) => a.port !== port)
        .map((a) => a.toString());

  // -------- 2. ActorSystem --------
  // Override the default `Info` level via `CHAT_LOG_LEVEL=debug` (or
  // `info`/`warn`/`error`/`off`).  Useful when you want to see what
  // the cluster, sharding, pubsub, persistence, HTTP and WS layers
  // are doing under the hood — every framework component now emits
  // structured `debug` lines for membership transitions, gossip,
  // failure-detector decisions, leader changes, shard allocations,
  // singleton reconciles, pubsub fan-out, persist/recovery, HTTP
  // requests and WS frames.
  const logLevel = parseLogLevel(process.env['CHAT_LOG_LEVEL']) ?? LogLevel.Info;
  const system = ActorSystem.create(SYSTEM_NAME, { logLevel });
  const seedSummary = seeds.length > 0
    ? ` · seeds=[${seeds.join(',')}]`
    : ' · bootstrap (no seeds)';
  system.log.info(
    `chat node starting · cluster=${cfg.host}:${port} · http=${cfg.host}:${cfg.httpPort} (singleton)${seedSummary}`,
  );

  // -------- 3. Persistence: SQLite journal under data-dir --------
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const journalPath = path.join(cfg.dataDir, 'chat.db');
  const journal = new SqliteJournal({ path: journalPath, wal: true });
  system.extension(PersistenceExtensionId).setJournal(journal);
  system.log.info(`SQLite journal · ${journalPath}`);

  // -------- 4. Cluster.join --------
  const cluster = await Cluster.join(system, {
    host: cfg.host,
    port,
    seeds,
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

  // -------- 5. DistributedData (presence + session tokens) + DistributedPubSub (broadcast) --------
  const ddHandle = system.extension(DistributedDataId).start(cluster, {
    gossipIntervalMs: 500,
  });
  const mediator = system.extension(DistributedPubSubId).start(cluster, {
    gossipIntervalMs: 500,
  });
  const sessions = new SessionStore(ddHandle);

  // -------- 6. ClusterSharding: one ChatRoomActor per room --------
  const sharding = ClusterSharding.get(system, cluster);
  const chatRoomRegion = sharding.start<ChatRoomCmd>({
    typeName: 'ChatRoom',
    entityProps: Props.create(() => new ChatRoomActor()),
    extractEntityId: (msg) => msg.room,
    numShards: 16,
  });

  // -------- 7. OnlineUsersActor (top-level, runs on every node) --------
  const onlineUsers = system.actorOf(
    Props.create(() => new OnlineUsersActor()),
    'online-users',
  );

  // -------- 8. HTTP front door — ClusterSingleton --------
  // Every node registers the same singleton spec; the cluster
  // elects ONE node to actually run the actor.  When that node
  // dies a surviving node spawns a fresh one which re-binds the
  // same port.  The downside is a brief outage during failover
  // (~5–10 s with these failure-detector settings) — fine for a
  // demo; production would still front this with a real LB.
  const staticDir = path.join(import.meta.dirname ?? __dirname, '..', 'static');
  system.extension(ClusterSingletonId).start(cluster, {
    typeName: 'http-ingress',
    props: httpIngressProps({
      host: cfg.host,
      httpPort: cfg.httpPort,
      staticDir,
      system,
      chatRoomRegion,
      onlineUsers,
      mediator,
      sessions,
    }),
  });

  // -------- 9. Graceful shutdown --------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    system.log.info(`received ${signal} — shutting down`);
    try {
      // `cluster.leave()` triggers the singleton manager's hand-off;
      // if this node was the holder, postStop runs (port released)
      // before terminate.
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

/**
 * Map a free-form `CHAT_LOG_LEVEL` env value (`debug` | `info` |
 * `warn` | `error` | `off`, case-insensitive) onto the framework's
 * `LogLevel` enum.  Returns `null` for unset/unknown values so the
 * caller can fall back to the default.
 */
function parseLogLevel(raw: string | undefined): LogLevel | null {
  if (!raw) return null;
  switch (raw.trim().toLowerCase()) {
    case 'debug': return LogLevel.Debug;
    case 'info':  return LogLevel.Info;
    case 'warn':  return LogLevel.Warn;
    case 'error': return LogLevel.Error;
    case 'off':   return LogLevel.Off;
    default:      return null;
  }
}

main().catch((err) => {
  process.stderr.write(`chat backend failed to start: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
