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
 * means "the bound one".
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
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
import { NoopLogger } from '../../../src/Logger.js';
import { getTcpBackend } from '../../../src/runtime/tcp/index.js';
import type { TcpListener } from '../../../src/runtime/tcp/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

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
