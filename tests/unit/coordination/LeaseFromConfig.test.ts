/**
 * `LeaseFromConfig` — the lease the framework builds from
 * `actor-ts.coordination.lease` for the three consumers that ask for one by
 * configuration (#1454).
 *
 * What the file decides is the backend and its tuning; the lease's identity is
 * the framework's.  So most of what is pinned here is the identity — the name
 * each consumer gets, and the owner each node gets — and the refusals that keep
 * a file from claiming either, or from switching on a lease nothing can build.
 *
 * The built leases go through the backend seam: `in-memory` is not selectable
 * and the Kubernetes backend talks to a real API server.  The seam receives
 * exactly what the real backend would, which is what these cases inspect.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import type { Lease } from '../../../src/coordination/Lease.js';
import {
  _substituteLeaseBackendForTest,
  checkLeaseConfiguration,
  configuredLeaseFor,
  DEFAULT_LEASE_BACKEND,
  readLeaseBackendFromConfig,
} from '../../../src/coordination/LeaseFromConfig.js';
import type { ConfiguredLeaseOptions } from '../../../src/coordination/LeaseFromConfig.js';
import { KubernetesLease } from '../../../src/coordination/leases/KubernetesLease.js';
import { Scheduler } from '../../../src/Scheduler.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/** The switch the refusals below are asked to name. */
const REQUESTED_BY = 'actor-ts.cluster.singleton.use-lease for singleton \'scheduler\'';

/** A lease that does nothing: the cases here are about what it was built from. */
const inertLease = (): Lease => ({
  acquire: async () => true,
  release: async () => {},
  checkAlive: () => false,
  onLost: () => () => {},
});

const configured = (block: string): Config => Config.parseString(`actor-ts.coordination.lease { ${block} }`);

/** A node at `orders@10.0.0.5:2552` in its run `incarnation`. */
const node = (incarnation?: string): NodeAddress => new NodeAddress('orders', '10.0.0.5', 2552, incarnation);

describe('readLeaseBackendFromConfig', () => {
  test('the bundled reference names no backend, so nothing is built', () => {
    expect(DEFAULT_LEASE_BACKEND).toBe('none');
    expectExactOptions(readLeaseBackendFromConfig(Config.loadReference()), 'none');
  });

  test('an absent key is undefined — the default is the caller\'s to apply', () => {
    expectExactOptions(readLeaseBackendFromConfig(Config.empty()), undefined);
  });

  test('reads kubernetes', () => {
    expectExactOptions(readLeaseBackendFromConfig(configured('backend = kubernetes')), 'kubernetes');
  });

  test('an unknown backend is refused, naming the key and the legal values', () => {
    const misspelt = configured('backend = kubernets');
    expect(() => readLeaseBackendFromConfig(misspelt)).toThrow(ConfigError);
    expect(() => readLeaseBackendFromConfig(misspelt))
      .toThrow(/actor-ts\.coordination\.lease\.backend must be one of none \| kubernetes \(got "kubernets"\)/);
  });

  test('in-memory is refused by name, not as an unknown word', () => {
    // It exists and ships; what it cannot do is guard anything when two nodes
    // build it, since each isolate holds its own store.
    const inMemory = configured('backend = in-memory');
    expect(() => readLeaseBackendFromConfig(inMemory)).toThrow(/in-memory is not selectable/);
    expect(() => readLeaseBackendFromConfig(inMemory)).toThrow(/own isolate/);
  });
});

describe('configuredLeaseFor — what is refused before anything is built', () => {
  test('a switch with no backend behind it is refused, naming the switch and the backend key', () => {
    // Both the shipped default and an explicit `none`.
    for (const config of [Config.loadReference(), configured('backend = none, ttl = 15s')]) {
      expect(() => configuredLeaseFor(config, REQUESTED_BY)).toThrow(ConfigError);
      expect(() => configuredLeaseFor(config, REQUESTED_BY)).toThrow(
        /actor-ts\.cluster\.singleton\.use-lease for singleton 'scheduler' asks for a lease built from configuration, but actor-ts\.coordination\.lease\.backend = none/,
      );
    }
  });

  test('no ttl is refused, naming the key — no default can stand for one', () => {
    expect(() => configuredLeaseFor(configured('backend = kubernetes'), REQUESTED_BY))
      .toThrow(/needs actor-ts\.coordination\.lease\.ttl/);
  });

  test('a value the backend rejects is refused naming the key it came from, not the field', () => {
    const tooShort = configured('backend = kubernetes, ttl = 15s, kubernetes.lease-name-max-length = 5');
    expect(() => configuredLeaseFor(tooShort, REQUESTED_BY)).toThrow(ConfigError);
    expect(() => configuredLeaseFor(tooShort, REQUESTED_BY))
      .toThrow(/^actor-ts\.coordination\.lease\.kubernetes\.lease-name-max-length: /);
  });

  test('an owner or a name written into the block is refused, not ignored', () => {
    for (const [leaf, value] of [['owner', '"pod-1"'], ['name', '"my-lease"']] as const) {
      const config = configured(`backend = kubernetes, ttl = 15s, ${leaf} = ${value}`);
      expect(() => configuredLeaseFor(config, REQUESTED_BY)).toThrow(ConfigError);
      expect(() => configuredLeaseFor(config, REQUESTED_BY))
        .toThrow(new RegExp(`^actor-ts\\.coordination\\.lease\\.${leaf} is read by nothing`));
    }
  });

  test('checkLeaseConfiguration refuses the same mistakes with no switch on at all', () => {
    // Where a node starts its cluster, so a misspelt backend is not left to the
    // first singleton started on demand.
    expect(() => checkLeaseConfiguration(configured('backend = etcd'))).toThrow(/must be one of none \| kubernetes/);
    expect(() => checkLeaseConfiguration(configured('plugin = kubernetes')))
      .toThrow(/actor-ts\.coordination\.lease\.plugin is read by nothing/);
    expect(() => checkLeaseConfiguration(Config.loadReference())).not.toThrow();
  });
});

describe('ConfiguredLease.build — the identity the framework gives a lease', () => {
  const built: Array<{ readonly options: ConfiguredLeaseOptions; readonly config: Config }> = [];
  let restore: () => void = () => {};

  beforeEach(() => {
    built.length = 0;
    restore = _substituteLeaseBackendForTest((options, config) => {
      built.push({ options, config });
      return inertLease();
    });
  });
  afterEach(() => { restore(); });

  const kubernetes = configured('backend = kubernetes, ttl = 15s');

  test('one name per consumer: the system, the consumer kind and the type', () => {
    const lease = configuredLeaseFor(kubernetes, REQUESTED_BY);
    lease.build({ kind: 'singleton', typeName: 'scheduler' }, node('a'));
    lease.build({ kind: 'sharding', typeName: 'cart' }, node('a'));
    lease.build({ kind: 'split-brain-resolver' }, node('a'));

    expect(built.map((entry) => entry.options.name)).toEqual([
      'orders-singleton-scheduler',
      'orders-sharding-cart',
      'orders-split-brain-resolver',
    ]);
  });

  test('a type name that is no valid object name is cleaned and kept apart by a hash', () => {
    const lease = configuredLeaseFor(kubernetes, REQUESTED_BY);
    lease.build({ kind: 'singleton', typeName: 'JobScheduler' }, node('a'));
    lease.build({ kind: 'singleton', typeName: 'jobScheduler' }, node('a'));

    const [first, second] = built.map((entry) => entry.options.name);
    expect(first).toMatch(/^orders-singleton-jobscheduler-[0-9a-z]{7}$/);
    expect(second).toMatch(/^orders-singleton-jobscheduler-[0-9a-z]{7}$/);
    expect(first).not.toBe(second);
  });

  test('the name fits lease-name-max-length from the same block', () => {
    const bounded = configured('backend = kubernetes, ttl = 15s, kubernetes.lease-name-max-length = 24');
    configuredLeaseFor(bounded, REQUESTED_BY).build({ kind: 'sharding', typeName: 'shopping-cart-entity' }, node('a'));

    expect(built[0]!.options.name.length).toBeLessThanOrEqual(24);
    expect(built[0]!.options.name).toMatch(/^orders-sharding-[0-9a-z-]*[0-9a-z]$/);
  });

  test('the owner is this node\'s address and incarnation, so a restart is a new holder', () => {
    const lease = configuredLeaseFor(kubernetes, REQUESTED_BY);
    lease.build({ kind: 'singleton', typeName: 'scheduler' }, node('first-run'));
    lease.build({ kind: 'singleton', typeName: 'scheduler' }, node('second-run'));
    lease.build({ kind: 'singleton', typeName: 'scheduler' }, node());

    expect(built.map((entry) => entry.options.owner)).toEqual([
      'orders@10.0.0.5:2552#first-run',
      'orders@10.0.0.5:2552#second-run',
      // An address that carries no incarnation is owned by the address alone.
      'orders@10.0.0.5:2552',
    ]);
  });

  test('the backend is handed the very config the block was read from', () => {
    // Not a second load: the consumer's system config, overrides and all.
    configuredLeaseFor(kubernetes, REQUESTED_BY).build({ kind: 'split-brain-resolver' }, node('a'));
    expect(built[0]!.config).toBe(kubernetes);
  });

  test('the renewal runs on the scheduler handed in, or on one of its own', () => {
    const scheduler = new ManualScheduler();
    const lease = configuredLeaseFor(kubernetes, REQUESTED_BY);
    lease.build({ kind: 'singleton', typeName: 'scheduler' }, node('a'), scheduler);
    lease.build({ kind: 'split-brain-resolver' }, node('a'));

    expect(built[0]!.options.scheduler).toBe(scheduler);
    // Never a raw host timer: a scheduler chains an interval longer than one
    // host timer holds instead of firing it every millisecond.
    expect(built[1]!.options.scheduler).toBeInstanceOf(Scheduler);
  });
});

describe('ConfiguredLease.build — the real backend', () => {
  test('kubernetes builds a KubernetesLease', () => {
    const lease = configuredLeaseFor(configured('backend = kubernetes, ttl = 15s'), REQUESTED_BY)
      .build({ kind: 'singleton', typeName: 'scheduler' }, node('a'), new ManualScheduler());
    expect(lease).toBeInstanceOf(KubernetesLease);
  });
});
