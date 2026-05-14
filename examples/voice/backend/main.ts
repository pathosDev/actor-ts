/**
 * Voice backend entry point — distributed voice server with three
 * modes (1:1 PTT, 1:N group megaphone, N:N rooms).  Sibling sample
 * to `examples/chat/`, designed to share as much wiring as possible
 * while exercising **different** framework primitives:
 *
 *   - `Receptionist` for 1:1 user-ref lookup (chat doesn't use it).
 *   - `DistributedPubSub` for per-group / per-room audio fan-out.
 *   - `DistributedData` ORSets for online + per-room presence
 *     (the chat sample uses similar ORSets but only per-room).
 *   - **No** `ClusterSharding` and **no** `PersistenceExtension`.
 *     Voice is ephemeral by design; rooms are pure pubsub-topic +
 *     CRDT membership.  This is the deliberate teaching contrast.
 *
 * Three terminals, no flags:
 *
 *   bun examples/voice/backend/main.ts
 *   bun examples/voice/backend/main.ts
 *   bun examples/voice/backend/main.ts
 *
 * Open `http://localhost:8081/`.  Whichever node currently holds the
 * `http-ingress` singleton serves traffic.  Kill that node and a
 * survivor takes over (~5-10 s).
 */
import * as path from 'node:path';
import {
  ActorSystem,
  Cluster,
  ClusterSingletonId,
  MemberDown,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  Props,
} from '../../../src/index.js';
import { DistributedDataId } from '../../../src/crdt/index.js';
import { DistributedPubSubId } from '../../../src/cluster/pubsub/index.js';
import { ReceptionistId } from '../../../src/discovery/Receptionist.js';
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
import { VoicePresenceActor } from './actors/VoicePresenceActor.js';
import { httpIngressProps } from './actors/HttpIngressActor.js';

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const SYSTEM_NAME = 'voice-cluster';

  // -------- 1. Cluster discovery (same shape as chat) --------
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
        .filter((a) => a.port !== port)
        .map((a) => a.toString());

  // -------- 2. ActorSystem --------
  const configFile = path.resolve(
    import.meta.dirname ?? __dirname, '..', 'application.conf',
  );
  const system = ActorSystem.create(SYSTEM_NAME, { configFile });
  const seedSummary = seeds.length > 0
    ? ` · seeds=[${seeds.join(',')}]`
    : ' · bootstrap (no seeds)';
  system.log.info(
    `voice node starting · cluster=${cfg.host}:${port} · http=${cfg.host}:${cfg.httpPort} (singleton)${seedSummary}`,
  );

  // -------- 3. Cluster.join --------
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

  // -------- 4. DistributedData + PubSub + Receptionist + SessionStore --------
  // Order matters: DD before SessionStore (it needs the handle); the
  // Receptionist before any actor that registers under it.
  const ddHandle = system.extension(DistributedDataId).start(cluster, {
    gossipIntervalMs: 500,
  });
  const mediator = system.extension(DistributedPubSubId).start(cluster, {
    gossipIntervalMs: 500,
  });
  const receptionist = system.extension(ReceptionistId).start(cluster, {
    gossipIntervalMs: 1_000,
  });
  const sessions = new SessionStore(ddHandle);

  // -------- 5. VoicePresenceActor (one per node) --------
  const voicePresence = system.spawn(
    Props.create(() => new VoicePresenceActor()),
    'voice-presence',
  );

  // -------- 6. HTTP front door — ClusterSingleton --------
  const staticDir = path.join(import.meta.dirname ?? __dirname, '..', 'static');
  system.extension(ClusterSingletonId).start(cluster, {
    typeName: 'http-ingress',
    props: httpIngressProps({
      host: cfg.host,
      httpPort: cfg.httpPort,
      staticDir,
      system,
      receptionist,
      mediator,
      voicePresence,
      sessions,
    }),
  });

  // -------- 7. Graceful shutdown --------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    system.log.info(`received ${signal} — shutting down`);
    try {
      await cluster.leave();
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
  process.stderr.write(`voice backend failed to start: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
