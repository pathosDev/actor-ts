/**
 * #1435 — `bootstrapCluster` reads the node's address from the config it
 * creates.
 *
 * It used to resolve host, port and both advertised values *before* it created
 * the `ActorSystem`, so none of them could see `system.config`.  Three things
 * the bootstrap decides before it calls `Cluster.join` take the advertised
 * identity — the stable-observation election orders on it, the seed filter
 * compares discovered addresses against it, and discovery pairs every peer
 * host it resolves with its port — and all three ran on a copy that had never
 * seen `actor-ts.remote.tcp.advertised-host` / `advertised-port`.  The join
 * then derived the configured identity, so the node elected on one address
 * and announced another: a genuine seed filtered out and a node that formed a
 * cluster of its own, an election lost that the node should have won, and
 * discovery dialling a port nothing was published on.
 *
 * Every case here goes through `bootstrapCluster` with the value in HOCON,
 * because that is the path the defect lived on: the same assertions made
 * through the builder are in `ClusterAdvertisedPort.test.ts` and pass
 * whether or not the bootstrap ever reads its config.
 *
 * The environment the bootstrap consults is saved and cleared around every
 * test, so a developer's exported `HOSTNAME` or `CLUSTER_PORT` cannot make a
 * case pass for the wrong reason.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import type { ActorSystem } from '../../../src/ActorSystem.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import type { Transport, WireHandler } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import type { SeedProvider } from '../../../src/discovery/index.js';
import { NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every variable the bootstrap path reads: the bind and identity chains, and
 * the discovery ladder behind the default `discovery: 'auto'`.
 */
const BOOTSTRAP_VARIABLES = [
  'CLUSTER_HOST',
  'POD_IP',
  'HOSTNAME',
  'CLUSTER_PORT',
  'CLUSTER_SEEDS',
  'CLUSTER_SERVICE_NAME',
  'CLUSTER_NAMESPACE',
  'KUBERNETES_SERVICE_HOST',
] as const;

const savedVariables = new Map<string, string | undefined>();
const started: ActorSystem[] = [];

beforeEach(() => {
  for (const name of BOOTSTRAP_VARIABLES) {
    savedVariables.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
  for (const [name, value] of savedVariables) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedVariables.clear();
});

/** Records every address the cluster dialled, and is otherwise the inner one. */
class DiallingTransport implements Transport {
  readonly dialled: string[] = [];

  constructor(private readonly inner: InMemoryTransport) {}

  get self(): NodeAddress { return this.inner.self; }
  start(): Promise<void> { return this.inner.start(); }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
  setHandler(handler: WireHandler): void { this.inner.setHandler(handler); }
  send(to: NodeAddress, message: WireMessage): void {
    this.dialled.push(to.toString());
    this.inner.send(to, message);
  }
  disconnect(peer: NodeAddress): void { this.inner.disconnect(peer); }
  peers(): NodeAddress[] { return this.inner.peers(); }
}

/**
 * A `RecordingLogger` that also records `close()`.  `ActorSystem.terminate`
 * closes the logger it was given — structurally, on any logger that has a
 * `close` — so this is what says a system the test never got a reference to
 * was torn down.
 */
class ClosingLogger extends RecordingLogger {
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * One A record for whatever was asked: echo the header and question, flip the
 * response bits, and append an answer whose name is the 0xc00c pointer back to
 * the question.  The instrument `ClusterAdvertisedPort.test.ts` uses for the
 * same observable, repeated here because a test file cannot import another
 * without registering its cases twice.
 */
function answerFor(query: Buffer, octets: readonly number[]): Buffer {
  let cursor = 12; // the fixed header; the question name starts here
  while (query[cursor] !== 0) cursor += query[cursor]! + 1;
  const questionEnd = cursor + 1 + 4; // the null label, then QTYPE and QCLASS
  const head = Buffer.from(query.subarray(0, questionEnd));
  head.writeUInt16BE(0x8180, 2); // response, recursion desired + available
  head.writeUInt16BE(1, 6); // one answer
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // name: pointer back to the question
  answer.writeUInt16BE(1, 2); // TYPE A
  answer.writeUInt16BE(1, 4); // CLASS IN
  answer.writeUInt32BE(60, 6); // TTL
  answer.writeUInt16BE(4, 10); // four bytes of address follow
  for (const [index, octet] of octets.entries()) answer.writeUInt8(octet, 12 + index);
  return Buffer.concat([head, answer]);
}

/**
 * Run `body` with a one-answer DNS server on loopback.  The discovery port
 * has no cheaper observable: the two rungs that consume it have to resolve a
 * host before they can stamp the port on it, and a fake provider bypasses the
 * port entirely.
 */
async function withDnsAnswering(
  octets: readonly number[],
  body: () => Promise<void>,
): Promise<void> {
  const dns = await import('node:dns/promises');
  const socket: Socket = createSocket('udp4');
  socket.on('message', (message, remote) => {
    socket.send(answerFor(message, octets), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => { socket.bind(0, '127.0.0.1', resolve); });
  // `setServers` is process-wide, so the restore below is not optional — and
  // neither is closing the socket, which would otherwise hold the loop open.
  const savedServers = dns.getServers();
  try {
    dns.setServers([`127.0.0.1:${socket.address().port}`]);
    await body();
  } finally {
    dns.setServers(savedServers);
    socket.close();
  }
}

/** Tunings that settle a fixed discovery answer in a few milliseconds. */
const FAST_OBSERVATION = {
  pollIntervalMs: 5,
  stableMarginMs: 0,
  maxWaitMs: 2_000,
  requiredContactPoints: 2,
  selfElectionGraceMs: 50,
};

/* -------------------------------------------------------------------------- */
/* The pre-join copies see the advertised identity the config names            */
/* -------------------------------------------------------------------------- */

/**
 * The shapes of the three pre-join cases in `ClusterAdvertisedPort.test.ts`,
 * with the builder's `withAdvertisedPort` / `withAdvertisedHost` replaced by
 * the HOCON key.  Each is written so that substituting the un-configured value
 * at exactly that one site changes the outcome.  The bind pair is named in
 * code here on purpose: it keeps each case about one key.
 */
describe('bootstrapCluster takes the advertised identity from HOCON before the join (#1435)', () => {
  test('the stable-observation election orders on a HOCON advertised-port', async () => {
    // `:3000` < `:4000` < `:58101`.  The discovered peer sits between the two
    // identities this node could present: advertised, it is the lowest and
    // wins; bound, the peer is.  A loser gets `'never'` and nothing listens on
    // `:4000`, so reaching `up` is only possible by having won.
    const name = 'hocon-advertised-port-election';
    const peer = new NodeAddress(name, '127.0.0.1', 4000);
    const discovery: SeedProvider = { lookup: async () => [peer] };
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(58101)
      .withConfig(Config.parseString('actor-ts.remote.tcp.advertised-port = 3000'))
      .withDiscovery(discovery)
      .withStableObservation(FAST_OBSERVATION)
      .withAwaitReady(false)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 3000)))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger());

    const bootstrapped = await bootstrapCluster(bootstrapOptions);
    started.push(bootstrapped.system);
    expect(bootstrapped.cluster.selfAddress.toString()).toBe(`${name}@127.0.0.1:3000`);
    await awaitCondition(() => bootstrapped.formedNewCluster, {
      timeoutMs: 3_000,
      label: 'the node won the election on its configured advertised port',
    });
  }, 15_000);

  test('the seed filter drops the HOCON advertised-port address, and only that one', async () => {
    // Discovery names both identities this node could be called by.  Filtering
    // on the bound port removes the one genuine seed and leaves the node
    // holding its own address, which `Cluster` drops as well — no seeds, and
    // `'immediate'` reads that as "I am the first node".
    const name = 'hocon-advertised-port-filter';
    const advertised = new NodeAddress(name, '127.0.0.1', 3000);
    const bound = new NodeAddress(name, '127.0.0.1', 58102);
    const discovery: SeedProvider = { lookup: async () => [advertised, bound] };
    const transport = new DiallingTransport(new InMemoryTransport(advertised));
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(58102)
      .withConfig(Config.parseString('actor-ts.remote.tcp.advertised-port = 3000'))
      .withDiscovery(discovery)
      .withAwaitReady(false)
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger());

    const bootstrapped = await bootstrapCluster(bootstrapOptions);
    started.push(bootstrapped.system);
    const dialled = [...transport.dialled];

    expect(dialled).toContain(bound.toString());
    expect(dialled).not.toContain(advertised.toString());
    expect(bootstrapped.formedNewCluster).toBe(false);
  }, 15_000);

  test('discovery pairs peer hosts with a HOCON advertised-port, not the bound one', async () => {
    // Stable observation, because that branch builds its own provider; the
    // plain branch's port is the seed filter's, pinned above.
    const name = 'hocon-advertised-port-discovery';
    const config = Config.parseString(`
      actor-ts.remote.tcp.advertised-port = 3000
      actor-ts.cluster.bootstrap.discovery.service-name = "nodes.actor-ts.test"
    `);
    const transport = new DiallingTransport(
      new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 3000)),
    );

    await withDnsAnswering([10, 0, 0, 9], async () => {
      const bootstrapOptions = ClusterBootstrapOptions.create(name)
        .withHost('127.0.0.1')
        .withPort(58103)
        .withDiscovery('dns')
        .withConfig(config)
        .withStableObservation(FAST_OBSERVATION)
        .withAwaitReady(false)
        .withTransport(transport)
        .withReceptionist(false)
        .withShutdownOnSignals(false)
        .withLogger(new NoopLogger());

      const bootstrapped = await bootstrapCluster(bootstrapOptions);
      started.push(bootstrapped.system);
      const dialled = [...transport.dialled];

      expect(dialled).toContain(`${name}@10.0.0.9:3000`);
      expect(dialled).not.toContain(`${name}@10.0.0.9:58103`);
    });
  }, 15_000);

  test('the seed filter drops the HOCON advertised-host address, and only that one', async () => {
    // The host half of the case two above.  The bound host is a real address
    // here, so an un-configured copy is not loopback by accident: it is the
    // bound `127.0.0.1`, and filtering on it throws the genuine seed away.
    const name = 'hocon-advertised-host-filter';
    const advertised = new NodeAddress(name, '10.9.9.9', 58104);
    const bound = new NodeAddress(name, '127.0.0.1', 58104);
    const discovery: SeedProvider = { lookup: async () => [advertised, bound] };
    const transport = new DiallingTransport(new InMemoryTransport(advertised));
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(58104)
      .withConfig(Config.parseString('actor-ts.remote.tcp.advertised-host = "10.9.9.9"'))
      .withDiscovery(discovery)
      .withAwaitReady(false)
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger());

    const bootstrapped = await bootstrapCluster(bootstrapOptions);
    started.push(bootstrapped.system);
    const dialled = [...transport.dialled];

    expect(bootstrapped.cluster.selfAddress.toString()).toBe(advertised.toString());
    expect(dialled).toContain(bound.toString());
    expect(dialled).not.toContain(advertised.toString());
    expect(bootstrapped.formedNewCluster).toBe(false);
  }, 15_000);

  test('the stable-observation election orders on a HOCON advertised-host', async () => {
    // `10.0.0.1` < `10.0.0.5` < `127.0.0.1`: advertised, this node is the
    // lowest and wins; on the bound host it sorts after the peer and loses.
    const name = 'hocon-advertised-host-election';
    const peer = new NodeAddress(name, '10.0.0.5', 58105);
    const discovery: SeedProvider = { lookup: async () => [peer] };
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(58105)
      .withConfig(Config.parseString('actor-ts.remote.tcp.advertised-host = "10.0.0.1"'))
      .withDiscovery(discovery)
      .withStableObservation(FAST_OBSERVATION)
      .withAwaitReady(false)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '10.0.0.1', 58105)))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger());

    const bootstrapped = await bootstrapCluster(bootstrapOptions);
    started.push(bootstrapped.system);
    await awaitCondition(() => bootstrapped.formedNewCluster, {
      timeoutMs: 3_000,
      label: 'the node won the election on its configured advertised host',
    });
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/* A refusal anywhere up to the join tears the system down                     */
/* -------------------------------------------------------------------------- */

describe('a bootstrap the join refuses does not leave its system running (#1435)', () => {
  test('a wildcard HOCON advertised-host is refused, and the system is terminated', async () => {
    // `Cluster.join` refuses a wildcard identity.  It sat outside the guard
    // that terminates the just-created system, so this refusal left a running
    // scheduler behind a rejected promise — and moving the config reads after
    // `ActorSystem.create` makes every config refusal on this path one of
    // those unless the guard reaches the join too.
    const name = 'hocon-wildcard-identity';
    const log = new ClosingLogger();
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(58106)
      .withConfig(Config.parseString('actor-ts.remote.tcp.advertised-host = "0.0.0.0"'))
      .withDiscovery({ lookup: async () => [] })
      .withAwaitReady(false)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 58106)))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(log);

    let caught: unknown;
    try {
      await bootstrapCluster(bootstrapOptions);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('advertisedHost');
    expect(log.closed, 'the refused bootstrap left its ActorSystem running').toBe(true);
  }, 15_000);
});
