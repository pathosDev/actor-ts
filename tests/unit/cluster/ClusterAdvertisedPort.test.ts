/**
 * #845 — the port half of the bind/advertise split that #944 opened on the
 * host.
 *
 * `port` was one value in two roles: `TcpTransport` bound it and `selfAddress`
 * gossiped it.  That is correct until something *remaps* the port — a
 * published container port, where the process listens on 2552 inside and peers
 * must dial whatever `-p 3000:2552` published — and there was no seam to say
 * so.  `withAdvertisedHost` fixed half of that deployment and nothing fixed the
 * other half.
 *
 * What is pinned here is the seam: the transport listens on `bindPort` while
 * `self` keeps the port peers dial, the resolver answers the same way for
 * `Cluster.join` and `bootstrapCluster`, and an unset advertised port still
 * means "the bound one".  The last section pins the half that a forwarded
 * `selfAddress` cannot cover — the three decisions `bootstrapCluster` takes
 * with the advertised port *before* it calls `join`.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import {
  ClusterOptions,
  ClusterOptionsValidator,
  resolveAdvertisedPort,
} from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Config } from '../../../src/config/Config.js';
import { InMemoryTransport, TcpTransport } from '../../../src/cluster/Transport.js';
import type { Transport, WireHandler } from '../../../src/cluster/Transport.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import type { SeedProvider } from '../../../src/discovery/index.js';
import { NoopLogger } from '../../../src/Logger.js';
import { getTcpBackend } from '../../../src/runtime/tcp/index.js';
import type { TcpListener } from '../../../src/runtime/tcp/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/* -------------------------------------------------------------------------- */
/* resolveAdvertisedPort — one rule, and the reason it is a function            */
/* -------------------------------------------------------------------------- */

describe('resolveAdvertisedPort', () => {
  test('an explicit advertisedPort wins', () => {
    expect(resolveAdvertisedPort({ port: 2552, advertisedPort: 3000 })).toBe(3000);
  });

  test('unset means the bound port — the historical single-value behaviour', () => {
    expect(resolveAdvertisedPort({ port: 2552 })).toBe(2552);
    expect(resolveAdvertisedPort({ port: 2552, advertisedPort: undefined })).toBe(2552);
  });

  test('a nonsense advertisedPort is handed back for the validator to refuse', () => {
    // Same shape as the host resolver: substituting a working value for one the
    // caller wrote on purpose is what would hide the mistake.
    expect(resolveAdvertisedPort({ port: 2552, advertisedPort: -1 })).toBe(-1);
    expect(resolveAdvertisedPort({ port: 2552, advertisedPort: 0 })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* ClusterOptionsValidator — positiveInt, not port()                            */
/* -------------------------------------------------------------------------- */

function validate(options: Partial<ClusterOptionsType>): void {
  new ClusterOptionsValidator().validate({ host: '127.0.0.1', port: 2552, ...options });
}

describe('ClusterOptionsValidator checks advertisedPort the way it checks port', () => {
  test('an unset advertisedPort passes — it is optional', () => {
    expect(() => validate({})).not.toThrow();
  });

  test('zero, negative and fractional values are refused', () => {
    expect(() => validate({ advertisedPort: 0 })).toThrow(OptionsError);
    expect(() => validate({ advertisedPort: -1 })).toThrow(OptionsError);
    expect(() => validate({ advertisedPort: 1.5 })).toThrow(OptionsError);
  });

  test('a value above the TCP range passes, exactly as `port` does', () => {
    // `positiveInt`, not `port()`: with InMemoryTransport the port is a
    // synthetic node-address discriminator (tests use e.g. 89001), and
    // validation here is transport-agnostic.
    expect(() => validate({ advertisedPort: 89_001 })).not.toThrow();
    expect(() => validate({ advertisedPort: 3000 })).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* TcpTransport — listens on bindPort, announces self.port                      */
/* -------------------------------------------------------------------------- */

const IDLE_HANDLERS = {
  onOpen: () => {},
  onData: () => {},
  onClose: () => {},
  onError: () => {},
};

/**
 * A port this process holds for the whole file, so `self.port` can be a number
 * that provably cannot be bound.  It is the port analogue of the host tests'
 * `203.0.113.1`: the assertion is that `start()` succeeds anyway, which it can
 * only do by having listened somewhere else.
 *
 * Taken with `port: 0` and read back rather than picked from a range, because a
 * hard-coded number is a Windows excluded-port-range failure waiting to happen
 * and a free-port probe that closes before the test runs is a race.
 */
let occupied: TcpListener | null = null;

async function occupiedPort(): Promise<number> {
  const backend = await getTcpBackend();
  occupied ??= await backend.listen({ host: '127.0.0.1', port: 0, handlers: IDLE_HANDLERS });
  return occupied.port;
}

afterAll(async () => {
  const listener = occupied;
  occupied = null;
  if (listener) await listener.close();
});

describe('TcpTransport binds bindPort and keeps self.port as the identity', () => {
  test('an unbindable self.port still starts when bindPort is a free one', async () => {
    const self = new NodeAddress('port-split', '127.0.0.1', await occupiedPort());
    // 0 is "any free port", so this cannot race another test for a number.
    const transport = new TcpTransport(self, new NoopLogger(), { bindHost: '127.0.0.1', bindPort: 0 });

    await transport.start();
    try {
      // The identity is untouched by where it bound — it is what the handshake
      // announces and what peers are keyed on.
      expect(transport.self.port).toBe(self.port);
    } finally {
      await transport.shutdown();
    }
  });

  test('without bindPort the same transport cannot bind at all', async () => {
    // The control case.  Without it the test above would pass just as happily
    // if `bindPort` were ignored, or if an omitted one silently fell through to
    // an ephemeral port instead of the one `self` announces.
    const self = new NodeAddress('port-split', '127.0.0.1', await occupiedPort());
    const transport = new TcpTransport(self, new NoopLogger(), { bindHost: '127.0.0.1' });

    await expect(transport.start()).rejects.toThrow();
    await transport.shutdown();
  });
});

/* -------------------------------------------------------------------------- */
/* Cluster — selfAddress carries the advertised port                            */
/* -------------------------------------------------------------------------- */

const started: ActorSystem[] = [];

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

function newSystem(name: string): ActorSystem {
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()));
  started.push(system);
  return system;
}

async function joinOn(
  name: string,
  port: number,
  options: Partial<ClusterOptionsType> = {},
): Promise<Cluster> {
  const clusterOptions = ClusterOptions.create()
    .withHost('127.0.0.1')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'transport-is-irrelevant', port)));
  return Cluster.join(newSystem(name), { ...clusterOptions, ...options } as ClusterOptionsType);
}

describe('Cluster.join gossips the advertised port, not the bound one', () => {
  test('selfAddress carries advertisedPort when one is named', async () => {
    const cluster = await joinOn('advertised-port-1', 57301, { advertisedPort: 3000 });

    expect(cluster.selfAddress.port).toBe(3000);
    expect(cluster.selfAddress.toString()).toBe('advertised-port-1@127.0.0.1:3000');
  });

  test('unset, it is the bound port — nothing configured today moves', async () => {
    const cluster = await joinOn('advertised-port-2', 57302);

    expect(cluster.selfAddress.port).toBe(57302);
  });

  test('a nonsense advertisedPort refuses the join outright', async () => {
    await expect(joinOn('advertised-port-3', 57303, { advertisedPort: 0 }))
      .rejects.toThrow(OptionsError);
  });

  test('a HOCON advertised-port reaches the join — the key ships wired', async () => {
    // `NoDeadConfigKeys` cannot see this key: it ships no leaf, so the leaf
    // walk never reaches it and the guard passes whether or not anything reads
    // it.  This is what proves it wired instead.
    //
    // `parseString`, not `fromObject`: a dotted string key would stay a
    // literal top-level key and `hasPath` would go on resolving the nested
    // reference value.
    const config = Config.parseString('actor-ts.remote.tcp.advertised-port = 3100');
    const system = ActorSystem.create(
      'advertised-port-hocon',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withConfig(config),
    );
    started.push(system);
    const clusterOptions = ClusterOptions.create()
      .withHost('127.0.0.1')
      .withPort(57305)
      .withSeeds([])
      .withTransport(
        new InMemoryTransport(new NodeAddress('advertised-port-hocon', 'irrelevant', 57305)),
      );

    const cluster = await Cluster.join(system, clusterOptions);

    expect(cluster.selfAddress.port).toBe(3100);
  });

  test('bootstrapCluster forwards it too — the election orders on the identity', async () => {
    const transport = new InMemoryTransport(
      new NodeAddress('bootstrap-port', '127.0.0.1', 3000),
    );
    const bootstrapOptions = ClusterBootstrapOptions.create('bootstrap-port')
      .withHost('127.0.0.1')
      .withPort(57304)
      .withAdvertisedPort(3000)
      .withSeeds([])
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger());
    const { system, cluster, shutdown } = await bootstrapCluster(bootstrapOptions);
    started.push(system);
    try {
      expect(cluster.selfAddress.port).toBe(3000);
    } finally {
      await shutdown();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* bootstrapCluster — the advertised port *before* the join                     */
/* -------------------------------------------------------------------------- */

/**
 * `bootstrapCluster` resolves the advertised port a second time rather than
 * letting `Cluster.join` own it, because three things need it *before* the
 * join and therefore have no cluster to ask: the stable-observation election
 * orders on this node's identity, the seed filter compares the discovered
 * addresses against it, and discovery pairs it with every peer host it
 * resolves.  Forwarding is not enough for any of them — by the time `join`
 * has derived the identity, all three decisions have been taken.
 *
 * The test above forwards and then reads `selfAddress` back, which the
 * forwarding at the end of `bootstrapCluster` satisfies on its own; it says
 * nothing about the three pre-join consumers.  These do, one each, and each
 * is written so that substituting the bound port at exactly *that* site — and
 * only that one — changes the outcome.
 */

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
 * One A record for whatever was asked: echo the header and question, flip the
 * response bits, and append an answer whose name is the 0xc00c pointer back to
 * the question.  Enough of the format to satisfy one `resolve4`, and no more.
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
 * Run `body` with a one-answer DNS server on loopback, because the discovery
 * port has no cheaper observable.
 *
 * That port is what turns a discovered *host* into a dialable address, and the
 * only two rungs that consume it — `DnsSeedProvider` in A-record mode and
 * `KubernetesApiSeedProvider` — have to resolve something before they can
 * stamp it on anything.  Neither takes an injected fetcher through
 * `AutoDiscoveryOptionsType`, and the two object forms of `discovery:` (a
 * `SeedProvider`, a `{ providers }` chain) bypass the port entirely, so a fake
 * provider observes nothing.  Answering the query is what is left, and
 * `node:dns/promises` honours a server named `host:port` — so this costs one
 * datagram and no real name resolution.
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

describe('bootstrapCluster resolves the advertised port for the pre-join steps', () => {
  test('the stable-observation election orders on the advertised identity', async () => {
    // Three addresses, ordered the way `Cluster.leader` orders them —
    // lexicographically on `system@host:port`, so `:3000` < `:4000` < `:57401`.
    // The discovered peer sits between the two identities this node could
    // present, which is what makes the election decide differently on each:
    // advertised, this node is the lowest and wins; bound, the peer is.
    //
    // The election's whole output is the self-election policy, and a loser
    // gets `'never'` — it stays `joining` until a peer promotes it.  Nothing
    // is listening on `:4000`, so reaching `up` here is only possible by
    // having been elected initial seed.
    const name = 'advertised-port-election';
    const peer = new NodeAddress(name, '127.0.0.1', 4000);
    const discovery: SeedProvider = { lookup: async () => [peer] };
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(57401)
      .withAdvertisedPort(3000)
      .withDiscovery(discovery)
      .withStableObservation({
        pollIntervalMs: 5,
        stableMarginMs: 0,
        maxWaitMs: 2_000,
        requiredContactPoints: 2,
        selfElectionGraceMs: 50,
      })
      // The bootstrap's own readiness wait would turn a lost election into a
      // `ClusterReadyTimeoutError` out of `bootstrapCluster` itself; waiting
      // on the observable instead keeps the failure attributable.
      .withAwaitReady(false)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 3000)))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger());

    const bootstrapped = await bootstrapCluster(bootstrapOptions);
    started.push(bootstrapped.system);
    try {
      await awaitCondition(() => bootstrapped.formedNewCluster, {
        timeoutMs: 3_000,
        label: 'the node won the election on its advertised identity and formed the cluster',
      });
    } finally {
      await bootstrapped.shutdown();
    }
  }, 15_000);

  test('the seed filter excludes the advertised address, and only that one', async () => {
    // The discovered set holds both identities this node could be named by:
    // the advertised one peers dial, and the bound one that is not an identity
    // at all.  Exactly one of them must survive, and it must be the bound one.
    //
    // Asserting only "self was excluded" would prove nothing, because `Cluster`
    // drops a seed equal to its own address as well — the wrong port passes
    // that half of the check for free.  What it cannot survive is the other
    // half: filtering on the bound port removes the one entry that was a
    // genuine seed and leaves the node holding its own address, which
    // `Cluster` then drops too.  The node is left with no seeds at all, and
    // `'immediate'` self-election reads an empty seed list as "I am the first
    // node" — the split brain this whole split exists to keep shut.
    const name = 'advertised-port-seed-filter';
    const advertised = new NodeAddress(name, '127.0.0.1', 3000);
    const bound = new NodeAddress(name, '127.0.0.1', 57402);
    const discovery: SeedProvider = { lookup: async () => [advertised, bound] };
    const transport = new DiallingTransport(new InMemoryTransport(advertised));
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(57402)
      .withAdvertisedPort(3000)
      .withDiscovery(discovery)
      .withAwaitReady(false)
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger());

    const bootstrapped = await bootstrapCluster(bootstrapOptions);
    started.push(bootstrapped.system);
    try {
      // Seed contact is synchronous inside the join, so the first round is
      // already recorded; snapshot it so a later gossip tick cannot drift the
      // assertion either way.
      const dialled = [...transport.dialled];

      expect(dialled).toContain(bound.toString());
      expect(dialled).not.toContain(advertised.toString());
      // It had a seed, so it never concluded it was alone.
      expect(bootstrapped.formedNewCluster).toBe(false);
    } finally {
      await bootstrapped.shutdown();
    }
  }, 15_000);

  test('discovery pairs peer hosts with the advertised port, not the bound one', async () => {
    // The deployment this whole split is for is symmetric: every node is
    // published on the same remapped port, so the port that turns a discovered
    // *host* into a dialable address is the advertised one.  Pairing peers
    // with the local bind port instead sends every node's first gossip frame
    // to a port nothing is published on — a cluster that never forms, from a
    // discovery answer that was entirely correct.
    //
    // Nothing cheaper reaches this: `DnsSeedProvider` (A-record mode) and
    // `KubernetesApiSeedProvider` are the only consumers of that port, and
    // both have to resolve something before they can stamp it on an address.
    const name = 'advertised-port-discovery';
    const serviceName = 'nodes.actor-ts.test';
    const config = Config.parseString(
      `actor-ts.cluster.bootstrap.discovery.service-name = "${serviceName}"`,
    );
    const transport = new DiallingTransport(
      new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 3000)),
    );

    await withDnsAnswering([10, 0, 0, 9], async () => {
      const bootstrapOptions = ClusterBootstrapOptions.create(name)
        .withHost('127.0.0.1')
        .withPort(57403)
        .withAdvertisedPort(3000)
        .withDiscovery('dns')
        .withConfig(config)
        // Stable observation, because this is the branch that builds its own
        // provider; the other branch's port is the seed filter's, pinned above.
        .withStableObservation({
          pollIntervalMs: 5,
          stableMarginMs: 0,
          maxWaitMs: 2_000,
          requiredContactPoints: 2,
          selfElectionGraceMs: 50,
        })
        .withAwaitReady(false)
        .withTransport(transport)
        .withReceptionist(false)
        .withShutdownOnSignals(false)
        .withLogger(new NoopLogger());

      const bootstrapped = await bootstrapCluster(bootstrapOptions);
      started.push(bootstrapped.system);
      try {
        const dialled = [...transport.dialled];

        expect(dialled).toContain(`${name}@10.0.0.9:3000`);
        expect(dialled).not.toContain(`${name}@10.0.0.9:57403`);
      } finally {
        await bootstrapped.shutdown();
      }
    });
  }, 15_000);
});
