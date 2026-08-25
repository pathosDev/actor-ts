/**
 * #944 — a node's bind address and the address it tells peers to dial were one
 * field, and its last resort was `0.0.0.0`.
 *
 * That value is not an identity.  Every node that reached it advertised the
 * byte-identical `<system>@0.0.0.0:<port>`, so each read the others'
 * self-announcements as claims about *itself*, `maySpeakFor` refused them, and
 * every member map ended up holding one entry — with nothing in the log to
 * distinguish a cluster that had not converged yet from one that never would.
 *
 * What is pinned here is the split and the chain that fills it: the resolver
 * never produces a wildcard, so the validator can refuse one outright; the
 * transport binds one address while announcing another; and a node that had to
 * derive its own identity says so.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import {
  ADVERTISED_HOST_ENV_VARS,
  ClusterOptions,
  ClusterOptionsValidator,
  DEFAULT_ADVERTISED_HOST,
  advertisedHostWasDerived,
  isWildcardHost,
  resolveAdvertisedHost,
} from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport, TcpTransport } from '../../../src/cluster/Transport.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/* -------------------------------------------------------------------------- */
/* resolveAdvertisedHost — the chain, one stage at a time                       */
/* -------------------------------------------------------------------------- */

/** An env with none of the three variables set, whatever the real one holds. */
const NO_ENV: Record<string, string | undefined> = {};

describe('resolveAdvertisedHost', () => {
  test('an explicit advertisedHost wins over everything else', () => {
    const resolved = resolveAdvertisedHost(
      { host: '10.0.0.5', advertisedHost: '10.0.0.9' },
      { CLUSTER_HOST: '10.0.0.7' },
    );

    expect(resolved).toBe('10.0.0.9');
  });

  test('a routable host is bound and advertised alike — env is not consulted', () => {
    // The historical single-value behaviour, and the reason nothing configured
    // correctly today moves: naming one host still means both jobs.
    const resolved = resolveAdvertisedHost({ host: '10.0.0.5' }, { POD_IP: '10.0.0.7' });

    expect(resolved).toBe('10.0.0.5');
  });

  test('a wildcard host is bound but never advertised — the env answers instead', () => {
    const resolved = resolveAdvertisedHost({ host: '0.0.0.0' }, { POD_IP: '10.0.0.7' });

    expect(resolved).toBe('10.0.0.7');
  });

  test('the env vars are consulted in order: CLUSTER_HOST, POD_IP, HOSTNAME', () => {
    expect(ADVERTISED_HOST_ENV_VARS).toEqual(['CLUSTER_HOST', 'POD_IP', 'HOSTNAME']);

    const all = { CLUSTER_HOST: 'named', POD_IP: '10.0.0.7', HOSTNAME: 'pod-7' };
    expect(resolveAdvertisedHost({ host: '0.0.0.0' }, all)).toBe('named');
    expect(resolveAdvertisedHost({ host: '0.0.0.0' }, { POD_IP: '10.0.0.7', HOSTNAME: 'pod-7' }))
      .toBe('10.0.0.7');
    expect(resolveAdvertisedHost({ host: '0.0.0.0' }, { HOSTNAME: 'pod-7' })).toBe('pod-7');
  });

  test('an env var that is itself a wildcard is skipped, not taken', () => {
    // Otherwise the chain would launder the defect through the environment:
    // POD_IP unset in the manifest and defaulted to 0.0.0.0 by a template is
    // the same identical string on every node.
    const resolved = resolveAdvertisedHost(
      { host: '0.0.0.0' },
      { CLUSTER_HOST: '0.0.0.0', POD_IP: '10.0.0.7' },
    );

    expect(resolved).toBe('10.0.0.7');
  });

  test('blank and whitespace-only env values fall through', () => {
    expect(resolveAdvertisedHost({ host: '::' }, { CLUSTER_HOST: '   ', POD_IP: '10.0.0.7' }))
      .toBe('10.0.0.7');
  });

  test('nothing at all resolves to loopback, never to a wildcard', () => {
    expect(resolveAdvertisedHost({ host: '0.0.0.0' }, NO_ENV)).toBe(DEFAULT_ADVERTISED_HOST);
    expect(resolveAdvertisedHost({}, NO_ENV)).toBe(DEFAULT_ADVERTISED_HOST);
    expect(isWildcardHost(DEFAULT_ADVERTISED_HOST)).toBe(false);
  });

  test('an explicit empty advertisedHost is handed back, not swallowed', () => {
    // It has to reach the validator: silently substituting a working address
    // for one the caller wrote on purpose is the failure mode this whole chain
    // exists to remove.
    expect(resolveAdvertisedHost({ host: '10.0.0.5', advertisedHost: '' }, NO_ENV)).toBe('');
  });

  test('an explicit wildcard advertisedHost is handed back for the validator to refuse', () => {
    expect(resolveAdvertisedHost({ host: '10.0.0.5', advertisedHost: '0.0.0.0' }, NO_ENV))
      .toBe('0.0.0.0');
  });
});

describe('advertisedHostWasDerived', () => {
  test('true only when nothing in the options named a dialable address', () => {
    expect(advertisedHostWasDerived({})).toBe(true);
    expect(advertisedHostWasDerived({ host: '0.0.0.0' })).toBe(true);
    expect(advertisedHostWasDerived({ host: '::' })).toBe(true);

    expect(advertisedHostWasDerived({ host: '10.0.0.5' })).toBe(false);
    expect(advertisedHostWasDerived({ host: '0.0.0.0', advertisedHost: '10.0.0.5' })).toBe(false);
    // Named, wrong, and still named — the validator's business, not this one's.
    expect(advertisedHostWasDerived({ host: '0.0.0.0', advertisedHost: '0.0.0.0' })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* ClusterOptionsValidator — a wildcard is not an identity                      */
/* -------------------------------------------------------------------------- */

function validate(options: Partial<ClusterOptionsType>): void {
  new ClusterOptionsValidator().validate({ host: '0.0.0.0', port: 2552, ...options });
}

describe('ClusterOptionsValidator refuses a wildcard advertised host', () => {
  // Every spelling that means "every interface" — the set is what makes the
  // rule hold, since each one resolves to the same string on every node.
  const wildcards = ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '[::]', '*', '  ', ''] as const;

  for (const advertisedHost of wildcards) {
    test(`"${advertisedHost}" is rejected`, () => {
      expect(() => validate({ advertisedHost })).toThrow(OptionsError);
    });
  }

  test('the message names the field and the way out', () => {
    try {
      validate({ advertisedHost: '0.0.0.0' });
      throw new Error('expected the validator to refuse');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('advertisedHost');
      expect(message).toContain('CLUSTER_HOST');
      expect(message).toContain('POD_IP');
    }
  });

  test('a real address passes, and so does a bound wildcard on its own', () => {
    expect(() => validate({ advertisedHost: '10.0.0.5' })).not.toThrow();
    expect(() => validate({ advertisedHost: '127.0.0.1' })).not.toThrow();
    // `host` is the bind target; a wildcard is correct there and is the
    // shipped default.
    expect(() => validate({})).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* TcpTransport — binds one address, announces another                          */
/* -------------------------------------------------------------------------- */

/**
 * A documentation address (TEST-NET-3, RFC 5737) that is assigned to no
 * interface on any machine running this suite.  Binding it fails; binding
 * loopback does not.  That difference is the assertion: if `start()` succeeds
 * with this as `self.host`, the listener took `bindHost` instead — which is
 * the whole point of the split.
 */
const UNBINDABLE_HOST = '203.0.113.1';

describe('TcpTransport binds bindHost and keeps self as the identity', () => {
  test('an unbindable self.host still starts when bindHost is loopback', async () => {
    const self = new NodeAddress('bind-split', UNBINDABLE_HOST, 0);
    const transport = new TcpTransport(self, new NoopLogger(), null, undefined, '127.0.0.1');

    await transport.start();
    try {
      // The identity is untouched by where it bound — it is what the handshake
      // announces and what peers are keyed on.
      expect(transport.self.host).toBe(UNBINDABLE_HOST);
    } finally {
      await transport.shutdown();
    }
  });

  test('without bindHost the same transport cannot bind at all', async () => {
    // The control case.  Without it the test above would pass just as happily
    // if `bindHost` were ignored and `self.host` were bindable after all.
    const self = new NodeAddress('bind-split', UNBINDABLE_HOST, 0);
    const transport = new TcpTransport(self, new NoopLogger());

    await expect(transport.start()).rejects.toThrow();
    await transport.shutdown();
  });
});

/* -------------------------------------------------------------------------- */
/* Cluster — selfAddress is the advertised host, and a derived one says so       */
/* -------------------------------------------------------------------------- */

type LogRecord = { readonly level: string; readonly message: string };

/** Collects everything the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

const started: ActorSystem[] = [];

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

function newSystem(name: string): { system: ActorSystem; log: RecordingLogger } {
  const log = new RecordingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(log));
  started.push(system);
  return { system, log };
}

/**
 * Run `body` with the three env vars cleared, then restore them.  The machine
 * running this may well export `HOSTNAME`, and a chain that silently picked it
 * up would make the loopback case pass for the wrong reason.
 */
async function withoutHostEnv(body: () => Promise<void>): Promise<void> {
  const saved = ADVERTISED_HOST_ENV_VARS.map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function joinOn(
  system: ActorSystem,
  name: string,
  port: number,
  options: Partial<ClusterOptionsType> = {},
): Promise<Cluster> {
  const clusterOptions = ClusterOptions.create()
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'transport-is-irrelevant', port)));
  return Cluster.join(system, { ...clusterOptions, ...options } as ClusterOptionsType);
}

describe('Cluster.join derives the advertised host and says when it had to', () => {
  test('selfAddress carries the advertised host, not the bound one', async () => {
    const { system } = newSystem('advertised-1');

    const cluster = await joinOn(system, 'advertised-1', 57101, {
      host: '0.0.0.0',
      advertisedHost: '10.0.0.5',
    });

    expect(cluster.selfAddress.host).toBe('10.0.0.5');
    expect(cluster.selfAddress.toString()).toBe('advertised-1@10.0.0.5:57101');
  });

  test('an unconfigured node advertises loopback and warns that it is alone-able', async () => {
    await withoutHostEnv(async () => {
      const { system, log } = newSystem('advertised-2');

      // No host at all: `reference.conf` supplies the `0.0.0.0` bind default,
      // which is exactly the path that used to gossip a wildcard.
      const cluster = await joinOn(system, 'advertised-2', 57102);

      expect(cluster.selfAddress.host).toBe(DEFAULT_ADVERTISED_HOST);
      const warnings = log.records.filter(
        (record) => record.level === 'warn' && record.message.includes('advertised address'),
      );
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toContain('CLUSTER_HOST');
      expect(warnings[0]!.message).toContain(`${DEFAULT_ADVERTISED_HOST}:57102`);
    });
  });

  test('a wildcard bind host plus POD_IP advertises the pod IP, at info', async () => {
    await withoutHostEnv(async () => {
      process.env.POD_IP = '10.0.0.7';
      const { system, log } = newSystem('advertised-3');

      const cluster = await joinOn(system, 'advertised-3', 57103, { host: '0.0.0.0' });

      expect(cluster.selfAddress.host).toBe('10.0.0.7');
      const infos = log.records.filter(
        (record) => record.level === 'info' && record.message.includes('advertising 10.0.0.7'),
      );
      expect(infos.length).toBe(1);
      // Derived, but dialable — nothing to warn about.
      expect(log.records.some((record) => record.level === 'warn'
        && record.message.includes('advertised address'))).toBe(false);
    });
  });

  test('a node that named its host says nothing about advertised addresses', async () => {
    const { system, log } = newSystem('advertised-4');

    const cluster = await joinOn(system, 'advertised-4', 57104, { host: '127.0.0.1' });

    expect(cluster.selfAddress.host).toBe('127.0.0.1');
    expect(log.records.some((record) => record.message.includes('advertised address'))).toBe(false);
    expect(log.records.some((record) => record.message.includes('advertising'))).toBe(false);
  });

  test('an explicit wildcard advertised host refuses the join outright', async () => {
    const { system } = newSystem('advertised-5');

    await expect(joinOn(system, 'advertised-5', 57105, {
      host: '0.0.0.0',
      advertisedHost: '0.0.0.0',
    })).rejects.toThrow(OptionsError);
  });

  test('bootstrapCluster reaches the same warning — it forwards only what was named', async () => {
    // The gap this closes is easy to reintroduce: `bootstrapCluster` derives
    // the advertised host itself, for the election and the seed filter, and if
    // it forwarded that derived value the join would see a named address and
    // stay quiet — silencing the warning on the path most deployments take.
    await withoutHostEnv(async () => {
      const log = new RecordingLogger();
      const transport = new InMemoryTransport(
        new NodeAddress('bootstrap-warn', DEFAULT_ADVERTISED_HOST, 57106),
      );
      const bootstrapOptions = ClusterBootstrapOptions.create('bootstrap-warn')
        .withHost('0.0.0.0')
        .withPort(57106)
        .withTransport(transport)
        .withReceptionist(false)
        .withShutdownOnSignals(false)
        .withLogger(log);
      const { system, cluster, shutdown } = await bootstrapCluster(bootstrapOptions);
      started.push(system);
      try {
        expect(cluster.selfAddress.host).toBe(DEFAULT_ADVERTISED_HOST);
        expect(log.records.some((record) => record.level === 'warn'
          && record.message.includes('advertised address'))).toBe(true);
      } finally {
        await shutdown();
      }
    });
  });

  test('however it is configured, a started node never advertises a wildcard', async () => {
    // The invariant behind #944, stated once.  The collision needs two nodes to
    // resolve to the *same* string, and every route to that string ran through
    // a wildcard — so a `selfAddress` that can never hold one is what closes
    // it, whatever the bind side is doing.
    const binds = ['0.0.0.0', '::', '*', '127.0.0.1', '10.0.0.5'] as const;

    await withoutHostEnv(async () => {
      for (const [index, host] of binds.entries()) {
        const { system } = newSystem(`invariant-${index}`);
        const cluster = await joinOn(system, `invariant-${index}`, 57200 + index, { host });

        expect(isWildcardHost(cluster.selfAddress.host)).toBe(false);
      }
    });
  });
});
