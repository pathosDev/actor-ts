/**
 * End-to-end test for {@link ClusterClient} (#86) — a process that
 * isn't a cluster member talks to actors on a real cluster via the
 * `ClusterClientReceptionist` extension.  Covers:
 *
 *   - Fire-and-forget tell.
 *   - Ask-and-reply round-trip with a real actor.
 *   - Unknown path → ask rejects with a deterministic error.
 *   - Contact-point failover: first contact-point unreachable, client
 *     transparently dials the second.
 *
 * Requires real TCP because the ClusterClient deliberately doesn't
 * piggy-back on the in-memory test transport — its whole reason to
 * exist is "outside-in" connectivity.  Ports are picked from a high
 * range with a per-run jitter to keep collisions rare on CI.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../src/cluster/ClusterOptions.js';
import { ClusterClient } from '../../src/cluster/ClusterClient.js';
import { ClusterClientOptions } from '../../src/cluster/ClusterClientOptions.js';
import { ClusterClientReceptionistId } from '../../src/cluster/ClusterClientReceptionist.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

interface CmdEcho { readonly kind: 'echo'; readonly payload: unknown }
interface CmdRing { readonly kind: 'ring' }
type Cmd = CmdEcho | CmdRing;

class EchoActor extends Actor<Cmd> {
  public rings = 0;
  override onReceive(msg: Cmd): void {
    if (msg.kind === 'echo') {
      this.context.sender.fold(
        () => { /* no sender, drop */ },
        (s) => s.tell(msg.payload),
      );
    } else {
      this.rings += 1;
    }
  }
}

interface NodeHandle {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly host: string;
  readonly port: number;
  readonly contactPoint: string;
  readonly echo: import('../../src/index.js').ActorRef<Cmd> & { actorImpl: EchoActor };
}

// Per-test-file jitter to avoid clashing with concurrent CI runs.
const PORT_BASE = 41_000 + Math.floor(Math.random() * 8_000);
let nextPort = PORT_BASE;
function pickPort(): number { return nextPort++; }

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<NodeHandle> {
  const system = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const cluster = await Cluster.join(
    system,
    ClusterOptions.create()
      .withHost('127.0.0.1')
      .withPort(port)
      .withSeeds(seeds)
      .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 600, downAfterMs: 1200 })
      .withGossipIntervalMs(200),
  );
  const echoImpl = new EchoActor();
  const echo = system.spawn(
    Props.create(() => echoImpl), 'echo',
  ) as unknown as NodeHandle['echo'];
  echo.actorImpl = echoImpl;
  // Start the receptionist — the cluster-side endpoint for outside-in.
  system.extension(ClusterClientReceptionistId).start(cluster);
  return { system, cluster, host: '127.0.0.1', port, contactPoint: `${systemName}@127.0.0.1:${port}`, echo };
}

async function stopNode(node: NodeHandle): Promise<void> {
  try { node.system.extension(ClusterClientReceptionistId).stop(); } catch { /* */ }
  await node.cluster.leave();
  await node.system.terminate();
}

let node: NodeHandle | null = null;
let client: ClusterClient | null = null;

beforeEach(() => { node = null; client = null; });
afterEach(async () => {
  try { await client?.close(); } catch { /* */ }
  if (node) await stopNode(node);
});

describe('ClusterClient — outside-in connectivity', () => {
  test('ask returns the actor reply', async () => {
    node = await startNode('cc-test', pickPort());
    client = new ClusterClient(ClusterClientOptions.create().withContactPoints([node.contactPoint]));
    const reply = await client.ask<{ x: number }>('echo', { kind: 'echo', payload: { x: 42 } });
    expect(reply).toEqual({ x: 42 });
  }, 10_000);

  test('send delivers a fire-and-forget message', async () => {
    node = await startNode('cc-test', pickPort());
    client = new ClusterClient(ClusterClientOptions.create().withContactPoints([node.contactPoint]));
    await client.send('echo', { kind: 'ring' });
    // No reply path; wait a beat for the message to land on the mailbox.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (node.echo.actorImpl.rings === 1) break;
      await Bun.sleep(20);
    }
    expect(node.echo.actorImpl.rings).toBe(1);
  }, 10_000);

  test('ask to unknown path rejects with a clear error', async () => {
    node = await startNode('cc-test', pickPort());
    client = new ClusterClient(ClusterClientOptions.create().withContactPoints([node.contactPoint]));
    let rejected = false;
    try {
      await client.ask('not/a/real/path', { hi: true });
    } catch (e) {
      rejected = true;
      expect((e as Error).message).toContain('path not found');
    }
    expect(rejected).toBe(true);
  }, 10_000);

  test('contact-point failover skips an unreachable address', async () => {
    // First contact-point is closed; second is the real node.  The
    // client should transparently fall through.
    const realPort = pickPort();
    const deadPort = pickPort();
    node = await startNode('cc-test', realPort);
    client = new ClusterClient(
      ClusterClientOptions.create().withContactPoints([
        `cc-test@127.0.0.1:${deadPort}`,   // nobody listening here
        `cc-test@127.0.0.1:${realPort}`,
      ]),
    );
    const reply = await client.ask<{ y: number }>('echo', { kind: 'echo', payload: { y: 7 } });
    expect(reply).toEqual({ y: 7 });
  }, 15_000);

  test('all contact-points unreachable → connect rejects', async () => {
    client = new ClusterClient(
      ClusterClientOptions.create().withContactPoints([
        `whatever@127.0.0.1:${pickPort()}`,
        `whatever@127.0.0.1:${pickPort()}`,
      ]),
    );
    let rejected = false;
    try {
      await client.ask('user/foo', { ping: true }, 1_000);
    } catch (e) {
      rejected = true;
      expect((e as Error).message.toLowerCase()).toMatch(/connect|contact-point/);
    }
    expect(rejected).toBe(true);
  }, 15_000);
});
