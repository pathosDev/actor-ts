/**
 * #836 — `actor-ts.cluster.seed-nodes` and `actor-ts.cluster.roles`.
 *
 * The tree used to publish, in four places, that these two had no HOCON form
 * because they are per-node identity.  Half of that argument was false about
 * this framework: `Cluster` removes this node's own address from its seed list
 * before dialling, so the shape the docs prescribe — name the designated first
 * node, ship one file everywhere — is correct on *every* node.  The other half
 * (`selfElection`) still holds and is unchanged.
 *
 * Three properties are pinned here, and the first two are the ones no existing
 * gate can see:
 *
 *   1. **the leaves are read**, exactly and only as lists, and explicit
 *      options still win per field.  `NoDeadConfigKeys` cannot show this: its
 *      accessor check is a substring match, and `ClusterOptions.ts` is full of
 *      `.roles`, so the guard would pass for `roles` even with no reader at
 *      all;
 *   2. **`bootstrapCluster` no longer shadows the file**.  Its
 *      `.withSeeds([...seeds])` was unconditional, and `mergeOptions` strips
 *      `undefined` and not `[]` — so an explicit empty list outranked HOCON on
 *      the headline path while every gate stayed green, because the key *is*
 *      read;
 *   3. **a malformed entry is refused before a socket exists**.
 *      `NodeAddress.parse` throws a bare `Error` from inside `_start`, *after*
 *      `transport.start()`; the validator runs in `Cluster.join` before the
 *      constructor.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import {
  ClusterOptions,
  ClusterOptionsValidator,
  readClusterOptionsFromConfig,
  withClusterConfigDefaults,
} from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/* -------------------------------------------------------------------------- */
/* The reader                                                                   */
/* -------------------------------------------------------------------------- */

describe('readClusterOptionsFromConfig reads the seed list and the roles (#836)', () => {
  test('both leaves read through as lists', () => {
    // `Config.parseString`, never `Config.fromObject` with a dotted key: the
    // dotted string would stay a literal top-level key and `hasPath` would
    // resolve the shipped `[]` behind it, so this would assert the default.
    const configured = Config.parseString(`
      actor-ts.cluster {
        seed-nodes = ["billing@10.0.0.5:2552", "10.0.0.6:2552"]
        roles      = ["backend", "reporting"]
      }
    `);

    // The whole object rather than two `toHaveProperty`s: a reader that also
    // punched in a default for a neighbouring leaf would satisfy per-key
    // assertions and still change what `Cluster.join` merges.
    expect(readClusterOptionsFromConfig(configured)).toEqual({
      seeds: ['billing@10.0.0.5:2552', '10.0.0.6:2552'],
      roles: ['backend', 'reporting'],
    });
  });

  test('each leaf stands alone — one does not imply the other', () => {
    expect(readClusterOptionsFromConfig(
      Config.parseString('actor-ts.cluster.roles = ["frontend"]'),
    )).toEqual({ roles: ['frontend'] });
    expect(readClusterOptionsFromConfig(
      Config.parseString('actor-ts.cluster.seed-nodes = ["app@n1:2552"]'),
    )).toEqual({ seeds: ['app@n1:2552'] });
  });

  test('an explicit seed list wins over the file, an unset one falls through', () => {
    const configured = Config.parseString('actor-ts.cluster.seed-nodes = ["app@from-file:2552"]');

    expect(withClusterConfigDefaults(configured, {} as ClusterOptionsType).seeds)
      .toEqual(['app@from-file:2552']);
    expect(withClusterConfigDefaults(
      configured,
      { host: 'h', port: 1, seeds: ['app@from-code:2552'] } as ClusterOptionsType,
    ).seeds).toEqual(['app@from-code:2552']);
  });

  test('an explicit roles list wins over the file, an unset one falls through', () => {
    const configured = Config.parseString('actor-ts.cluster.roles = ["from-file"]');

    expect(withClusterConfigDefaults(configured, {} as ClusterOptionsType).roles)
      .toEqual(['from-file']);
    expect(withClusterConfigDefaults(
      configured,
      { host: 'h', port: 1, roles: ['from-code'] } as ClusterOptionsType,
    ).roles).toEqual(['from-code']);
  });

  test('the per-entry substitution form is the one that works', () => {
    // Written down because the obvious form does not work and fails loudly at
    // start-up rather than quietly: `reference.conf` spells this recipe out
    // beside the key, and this is what says the recipe is true.
    process.env.ACTOR_TS_TEST_SEED_1 = 'app@10.0.0.5:2552';
    delete process.env.ACTOR_TS_TEST_SEED_2;
    try {
      const configured = Config.parseString(
        'actor-ts.cluster.seed-nodes = [ ${?ACTOR_TS_TEST_SEED_1}, ${?ACTOR_TS_TEST_SEED_2} ]',
      );

      // The unset one is dropped from the array rather than landing as a hole,
      // which is what makes one file work for a deployment whose node count
      // varies.
      expect(readClusterOptionsFromConfig(configured)).toEqual({ seeds: ['app@10.0.0.5:2552'] });
    } finally {
      delete process.env.ACTOR_TS_TEST_SEED_1;
    }
  });

  test('a single substitution is refused, not split on commas', () => {
    // The decision this records: the leaf is read with `getStringList` and
    // nothing else, so `seed-nodes = ${?SEED_NODES}` is a type error rather
    // than a second accepted syntax.  Six other list leaves in the file behave
    // this way, and the comma-separated single variable already has a
    // first-class home in `seedsFromEnv(...)`; a leaf that took both would be
    // the only one an operator could not predict from the others.
    process.env.ACTOR_TS_TEST_SEED_NODES = 'app@10.0.0.5:2552,app@10.0.0.6:2552';
    try {
      const configured = Config.parseString(
        'actor-ts.cluster.seed-nodes = ${?ACTOR_TS_TEST_SEED_NODES}',
      );

      expect(configured.hasPath('actor-ts.cluster.seed-nodes')).toBe(true);
      expect(() => readClusterOptionsFromConfig(configured)).toThrow(ConfigError);
    } finally {
      delete process.env.ACTOR_TS_TEST_SEED_NODES;
    }
    // And with the variable unset the optional substitution simply misses, so
    // the key is absent and the reference `[]` is what a system would see.
    expect(readClusterOptionsFromConfig(
      Config.parseString('actor-ts.cluster.seed-nodes = ${?ACTOR_TS_TEST_SEED_NODES}'),
    )).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* The validator                                                                */
/* -------------------------------------------------------------------------- */

describe('ClusterOptionsValidator checks seed syntax before anything binds (#836)', () => {
  const validate = (seeds: string[]): void => {
    new ClusterOptionsValidator().validate({ host: '127.0.0.1', port: 2552, seeds });
  };

  test('an empty list is legal — it is the documented "I am the first node"', () => {
    expect(() => validate([])).not.toThrow();
  });

  test('both accepted spellings pass', () => {
    // `Cluster._start` prefixes this system's name onto an entry without one,
    // so the bare form has to pass here or the validator would refuse what the
    // cluster accepts.
    expect(() => validate(['billing@10.0.0.5:2552', '10.0.0.6:2552'])).not.toThrow();
  });

  test('a missing port is refused, and the message names the entry', () => {
    expect(() => validate(['10.0.0.5'])).toThrow(OptionsError);
    expect(() => validate(['10.0.0.5'])).toThrow(/10\.0\.0\.5/);
    expect(() => validate(['billing@10.0.0.5'])).toThrow(OptionsError);
  });

  test('an empty or non-string entry is refused', () => {
    expect(() => validate([''])).toThrow(OptionsError);
    expect(() => validate(['   '])).toThrow(OptionsError);
    expect(() => validate([42 as unknown as string])).toThrow(OptionsError);
  });
});

/* -------------------------------------------------------------------------- */
/* Cluster.join                                                                 */
/* -------------------------------------------------------------------------- */

const started: ActorSystem[] = [];

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

function newSystem(name: string, hocon?: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
  if (hocon !== undefined) systemOptions.withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(name, systemOptions);
  started.push(system);
  return system;
}

/** A join that names everything except the two fields under test. */
function joinOn(
  system: ActorSystem,
  name: string,
  port: number,
  extra: Partial<ClusterOptionsType> = {},
): Promise<Cluster> {
  const clusterOptions = ClusterOptions.create()
    .withHost('127.0.0.1')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', port)));
  return Cluster.join(system, { ...clusterOptions, ...extra } as ClusterOptionsType);
}

describe('Cluster.join takes the seed list and the roles from config (#836)', () => {
  test('a configured seed list stops the node forming a cluster of its own', async () => {
    // The behavioural observable, not the merged object: with `'immediate'`
    // self-election a node self-elects exactly when its (self-excluded) seed
    // list is empty.  The seed here is nobody, so an inert key would show up
    // as a node that came `up` alone — which is the failure #836 is about.
    const system = newSystem(
      'seeds-hocon',
      'actor-ts.cluster.seed-nodes = ["seeds-hocon@127.0.0.1:57402"]',
    );

    const cluster = await joinOn(system, 'seeds-hocon', 57401);

    expect(cluster.expectsRemotePeers()).toBe(true);
    expect(cluster.selfElected).toBe(false);
    expect(cluster.selfMember()?.status).toBe('joining');
  });

  test('the shipped empty list is still "I am the first node"', async () => {
    // The other arm, and it has to be here: without it the assertion above
    // would also pass against a build that never came up at all.
    const system = newSystem('seeds-default');

    const cluster = await joinOn(system, 'seeds-default', 57403);

    expect(cluster.expectsRemotePeers()).toBe(false);
    expect(cluster.selfElected).toBe(true);
  });

  test('this node filters itself out, so one shared list is correct everywhere', async () => {
    // The claim that reverses the published position, asserted rather than
    // argued: the designated first node reads the very file that names it and
    // still self-elects, because its own address is removed before dialling.
    const system = newSystem(
      'seeds-self',
      'actor-ts.cluster.seed-nodes = ["seeds-self@127.0.0.1:57404"]',
    );

    const cluster = await joinOn(system, 'seeds-self', 57404);

    expect(cluster.expectsRemotePeers()).toBe(false);
    expect(cluster.selfElected).toBe(true);
  });

  test('an explicit seed list still wins over the file', async () => {
    const system = newSystem(
      'seeds-explicit',
      'actor-ts.cluster.seed-nodes = ["seeds-explicit@127.0.0.1:57406"]',
    );

    const cluster = await joinOn(system, 'seeds-explicit', 57405, { seeds: [] });

    // `seeds: []` is an explicit "there is nobody else" and outranks the file,
    // so the node forms its own cluster despite the configured seed.
    expect(cluster.expectsRemotePeers()).toBe(false);
    expect(cluster.selfElected).toBe(true);
  });

  test('configured roles land on the self member', async () => {
    const system = newSystem('roles-hocon', 'actor-ts.cluster.roles = ["backend", "reporting"]');

    const cluster = await joinOn(system, 'roles-hocon', 57407);

    expect([...cluster.selfRoles].sort()).toEqual(['backend', 'reporting']);
    expect([...(cluster.selfMember()?.roles ?? [])].sort()).toEqual(['backend', 'reporting']);
  });

  test('explicit roles win over the file', async () => {
    const system = newSystem('roles-explicit', 'actor-ts.cluster.roles = ["from-file"]');

    const cluster = await joinOn(system, 'roles-explicit', 57408, { roles: ['from-code'] });

    expect([...cluster.selfRoles]).toEqual(['from-code']);
  });

  test('a malformed configured seed is refused before the transport starts', async () => {
    // The point of the validator rule.  Left to `_start`, `NodeAddress.parse`
    // throws a bare `Error` *after* `transport.start()` — a node down with a
    // bound socket behind it and a message naming neither the field nor the
    // key.  A config-sourced list makes the typo far likelier than a
    // code-sourced one.
    const system = newSystem('seeds-typo', 'actor-ts.cluster.seed-nodes = ["10.0.0.5"]');
    const transport = new InMemoryTransport(new NodeAddress('seeds-typo', '127.0.0.1', 57409));

    await expect(
      joinOn(system, 'seeds-typo', 57409, { transport }),
    ).rejects.toThrow(OptionsError);
    // Nothing was started: the registry only gains an entry in
    // `InMemoryTransport.start`, which `_start` reaches after the validator.
    expect(transport.peers().some((peer) => peer.port === 57409)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* bootstrapCluster — the shadowing trap                                        */
/* -------------------------------------------------------------------------- */

describe('bootstrapCluster no longer shadows a configured seed list (#836)', () => {
  async function bootstrapOn(
    name: string,
    port: number,
    hocon: string,
    seeds?: string[],
  ): Promise<{ cluster: Cluster; shutdown: () => Promise<void> }> {
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', port)))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withAwaitReady(false)
      .withLogger(new NoopLogger())
      .withConfig(Config.parseString(hocon));
    if (seeds !== undefined) bootstrapOptions.withSeeds(seeds);
    const { system, cluster, shutdown } = await bootstrapCluster(bootstrapOptions);
    started.push(system);
    return { cluster, shutdown };
  }

  test('an empty discovery result falls through to the file', async () => {
    // The regression this closes: `.withSeeds([...seeds])` was unconditional,
    // `stripUndefined` does not strip `[]`, and an explicit empty list outranks
    // HOCON — so the key was read on this path and reached nothing.
    const { cluster, shutdown } = await bootstrapOn(
      'bootstrap-seeds',
      57421,
      'actor-ts.cluster.seed-nodes = ["bootstrap-seeds@127.0.0.1:57422"]',
    );
    try {
      expect(cluster.expectsRemotePeers()).toBe(true);
      expect(cluster.selfElected).toBe(false);
    } finally {
      await shutdown();
    }
  });

  test('a caller-written empty seed list still outranks the file', async () => {
    // The other arm, and it is what keeps the fix from being a precedence bug
    // in the opposite direction: `seeds: []` on the bootstrap options is an
    // explicit "there is nobody else", not an absent answer.
    const { cluster, shutdown } = await bootstrapOn(
      'bootstrap-explicit',
      57423,
      'actor-ts.cluster.seed-nodes = ["bootstrap-explicit@127.0.0.1:57424"]',
      [],
    );
    try {
      expect(cluster.expectsRemotePeers()).toBe(false);
      expect(cluster.selfElected).toBe(true);
    } finally {
      await shutdown();
    }
  });

  test('configured roles reach the join through bootstrapCluster too', async () => {
    const { cluster, shutdown } = await bootstrapOn(
      'bootstrap-roles',
      57425,
      'actor-ts.cluster.roles = ["backend"]',
      [],
    );
    try {
      expect([...cluster.selfRoles]).toEqual(['backend']);
    } finally {
      await shutdown();
    }
  });
});
