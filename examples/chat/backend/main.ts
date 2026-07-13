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
 * under `actors/`, and the directive DSL routes (landing page, static
 * files, the /ws upgrade) live in `routes.ts`.  Nothing here imports
 * `fastify` directly; everything goes through `HttpExtension`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ActorSystem,
  ActorSystemOptions,
  Cluster,
  ClusterOptions,
  ClusterSingletonId,
  MemberDown,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  PersistenceExtensionId,
  Props,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
  StartShardingOptions,
  StartSingletonOptions,
} from '../../../src/index.js';
import { DistributedDataId, DistributedDataOptions } from '../../../src/crdt/index.js';
import { DistributedPubSubId, DistributedPubSubOptions } from '../../../src/cluster/pubsub/index.js';
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
import { ChatRoomDirectoryActor } from './actors/ChatRoomDirectoryActor.js';
import {
  DmChannelActor,
  type DmChannelCmd,
} from './actors/DmChannelActor.js';
import { OnlineUsersActor } from './actors/OnlineUsersActor.js';
import { ReadReceiptsActor } from './actors/ReadReceiptsActor.js';
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
  // Hand the framework's HOCON loader a path to this sample's
  // `application.conf` so config knobs (log level, gossip cadence,
  // failure-detector thresholds, journal plugin) actually drive the
  // system.  Without `configFile`, the loader looks in the CWD —
  // which is the repo root when this is invoked as
  // `bun examples/chat/backend/main.ts`, where there is no
  // `application.conf`.
  const configFile = path.resolve(
    import.meta.dirname ?? __dirname, '..', 'application.conf',
  );
  const systemOptions = ActorSystemOptions.create().withConfigFile(configFile);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  const seedSummary = seeds.length > 0
    ? ` · seeds=[${seeds.join(',')}]`
    : ' · bootstrap (no seeds)';
  system.log.info(
    `chat node starting · cluster=${cfg.host}:${port} · http=${cfg.host}:${cfg.httpPort} (singleton)${seedSummary}`,
  );

  // -------- 3. Persistence: SQLite journal + snapshot store -----------
  // Snapshot store keeps `ChatRoomActor` recovery bounded: without it,
  // a long-running room replays the entire journal slice on every cold
  // start (the room's snapshot policy fires every 100 events — see the
  // actor for the rationale).  Both stores share a `data-dir` and the
  // same DB-file family.
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const journalPath = path.join(cfg.dataDir, 'chat.db');
  const snapshotPath = path.join(cfg.dataDir, 'chat-snapshots.db');
  const journalOptions = SqliteJournalOptions.create()
    .withPath(journalPath)
    .withWal(true);
  const journal = new SqliteJournal(journalOptions);
  const snapshotOptions = SqliteSnapshotStoreOptions.create()
    .withPath(snapshotPath)
    .withKeepN(3);
  const snapshotStore = new SqliteSnapshotStore(snapshotOptions);
  const persistence = system.extension(PersistenceExtensionId);
  persistence.setJournal(journal);
  persistence.setSnapshotStore(snapshotStore);
  system.log.info(`SQLite journal · ${journalPath}`);
  system.log.info(`SQLite snapshot store · ${snapshotPath} (keepN=3)`);

  // -------- 4. Cluster.join --------
  const clusterOptions = ClusterOptions.create()
    .withHost(cfg.host)
    .withPort(port)
    .withSeeds(seeds)
    .withFailureDetector({
      heartbeatIntervalMs: 300,
      unreachableAfterMs: 1500,
      downAfterMs: 4000,
    })
    .withGossipIntervalMs(500);
  const cluster = await Cluster.join(system, clusterOptions);
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
  const ddOptions = DistributedDataOptions.create().withGossipInterval(500);
  const ddHandle = system.extension(DistributedDataId).start(cluster, ddOptions);
  const pubSubOptions = DistributedPubSubOptions.create().withGossipIntervalMs(500);
  const mediator = system.extension(DistributedPubSubId).start(cluster, pubSubOptions);
  const sessions = new SessionStore(ddHandle);
  if (sessions.usingDemoSecret) {
    system.log.warn(
      'session tokens signed with the demo fallback secret — set CHAT_TOKEN_SECRET to a strong random string for production',
    );
  }

  // -------- 6. ClusterSharding: one ChatRoomActor per room --------
  const sharding = cluster.sharding;
  const chatRoomRegion = sharding.start('ChatRoom', ChatRoomActor,
    StartShardingOptions.create<ChatRoomCmd>()
      .withExtractEntityId((msg) => msg.room)
      .withNumShards(16));

  // -------- 6b. ClusterSharding: one DmChannelActor per pair --------
  // Same sharding shape, separate typeName so the two entity sets
  // live in disjoint shard regions.  `entityId = pairId` — see
  // `shared/dm.ts` for the canonicalization.  Sixteen shards matches
  // the chat-room region; the DM workload is similar (write-heavy,
  // small per-entity state) so a single tuning value covers both.
  const dmChannelRegion = sharding.start('DmChannel', DmChannelActor,
    StartShardingOptions.create<DmChannelCmd>()
      .withExtractEntityId((msg) => msg.pairId)
      .withNumShards(16));

  // -------- 7. OnlineUsersActor (top-level, runs on every node) --------
  const onlineUsers = system.spawn(
    Props.create(() => new OnlineUsersActor()),
    'online-users',
  );

  // -------- 7a. ReadReceiptsActor (top-level, every node) --------
  // Per-room read-up-to pointers, persisted via a DistributedData
  // LWWMap (`read-up-to.<room>` → `LWWMap<username, ts>`).  Same
  // fan-out pattern as `OnlineUsersActor`: each interested local
  // session subscribes here once per room, the actor maintains a
  // single DD-level subscription on its behalf.
  const readReceipts = system.spawn(
    Props.create(() => new ReadReceiptsActor()),
    'read-receipts',
  );

  // -------- 7b. ChatRoomDirectoryActor (top-level, every node) --------
  // The directory wraps a DistributedData ORSet that is the actual
  // cluster-wide source of truth — every node spawns its own actor
  // instance so the WS plugin on this node has a local ref to talk
  // to.  Multiple instances are safe: the ORSet converges, the seed
  // step is idempotent (ORSet.add of an existing element is a no-op),
  // and each instance fans out only to its own local subscribers.
  // No singleton needed.
  const roomDirectory = system.spawn(
    Props.create(() => new ChatRoomDirectoryActor()),
    'chat-room-directory',
  );

  // -------- 8. TLS material (optional) --------
  // When `--tls-cert` / `--tls-key` are present we read the PEMs once
  // here and pass the buffers to the singleton's HttpIngressActor; the
  // singleton manager spawns one of those on whichever node currently
  // holds the http-ingress, and Fastify's HTTPS option turns the
  // listener into a TLS-terminating server.  Frontends already pick
  // `wss:` based on `location.protocol`, so no client change is
  // required to flip the whole sample to TLS.
  const tls = (cfg.tlsCert && cfg.tlsKey)
    ? {
        cert: fs.readFileSync(cfg.tlsCert),
        key:  fs.readFileSync(cfg.tlsKey),
      }
    : undefined;
  if (tls) {
    system.log.info(`TLS enabled · cert=${cfg.tlsCert} · key=${cfg.tlsKey}`);
  }

  // -------- 9. HTTP front door — ClusterSingleton --------
  // Every node registers the same singleton spec; the cluster
  // elects ONE node to actually run the actor.  When that node
  // dies a surviving node spawns a fresh one which re-binds the
  // same port.  The downside is a brief outage during failover
  // (~5–10 s with these failure-detector settings) — fine for a
  // demo; production would still front this with a real LB.
  const staticDir = path.join(import.meta.dirname ?? __dirname, '..', 'static');
  const singletonOptions = StartSingletonOptions.create()
    .withTypeName('http-ingress')
    .withProps(httpIngressProps({
      host: cfg.host,
      httpPort: cfg.httpPort,
      staticDir,
      system,
      chatRoomRegion,
      dmChannelRegion,
      onlineUsers,
      mediator,
      sessions,
      roomDirectory,
      readReceipts,
      ...(tls ? { tls } : {}),
    }));
  system.extension(ClusterSingletonId).start(cluster, singletonOptions);

  // -------- 10. Graceful shutdown --------
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
      await snapshotStore.close();
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
