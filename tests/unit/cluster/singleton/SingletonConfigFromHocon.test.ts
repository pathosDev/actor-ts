/**
 * `actor-ts.cluster.singleton.*` has to change **behaviour**, not just an
 * options object (#855).
 *
 * `SingletonConfigDefaults.test.ts` proves the reader returns the right shape,
 * and `NoDeadConfigKeys` proves something under `src/` mentions each key — but
 * that second proof is close to worthless here, exactly as it was for
 * `sharding.role` (#847): its read-check is `includes('ConfigKeys.cluster')`
 * and `includes('.role')` in one file, and `.role` is a substring almost any
 * cluster file carries.  So the real gate is here.
 *
 * Two doors, and the second one is the point of the whole block.  `start()`
 * merges the block under the caller's options the way `ClusterSharding.start`
 * already did, so those assertions read off the manager the extension built.
 * `ref()` is new: it takes no options object at all, which is why a proxy-only
 * node had **no way whatsoever** to set its buffer cap or learn a role before
 * this — so the assertions there are on the proxy's own observable state.
 *
 * Single node throughout, and `InMemoryTransport`, so no port is ever bound.
 * One node is enough to make the role filter's verdict total: `singletonHost`
 * under a role is the first `up` member carrying it, and a node that carries
 * no roles carries none.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { Config } from '../../../../src/config/Config.js';
import { SingletonKey } from '../../../../src/cluster/singleton/SingletonKey.js';
import { StartSingletonOptions } from '../../../../src/cluster/singleton/StartSingletonOptions.js';
import type { ClusterSingletonProxy } from '../../../../src/cluster/singleton/ClusterSingletonProxy.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'configured';

class WorkerActor extends Actor<string> {
  static readonly singleton = SingletonKey.of<string>(TYPE_NAME);
  override onReceive(): void { /* placement is what is under test, not delivery */ }
}

/** The manager fields the extension copies across, as the instance holds them. */
type ManagerInternals = {
  readonly options: {
    readonly role?: string;
    readonly acquireRetryIntervalMs?: number;
    readonly handOverTimeoutMs?: number;
    readonly maxHandOverStateBytes?: number;
    readonly restartOnTermination?: boolean;
  };
};

type Node = { readonly system: ActorSystem; readonly cluster: Cluster };

let running: Node | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
});

/**
 * `Config.parseString` and not `Config.fromObject({'actor-ts.x.y': …})`: the
 * latter keeps the dotted string as one literal top-level key, so `hasPath`
 * would go on resolving the nested `reference.conf` value and every assertion
 * below would be against the shipped defaults.
 */
async function startNode(name: string, port: number, hocon?: string): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (hocon !== undefined) systemOptions.withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(name, systemOptions);

  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(50);
  const cluster = await Cluster.join(system, clusterOptions);

  const node: Node = { system, cluster };
  running = node;
  return node;
}

function managerInstance(node: Node): ManagerInternals | null {
  const ref = node.cluster.singleton.managerFor(TYPE_NAME);
  if (ref.isNone()) return null;
  const cell = (ref.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  return (cell?.actor as ManagerInternals | undefined) ?? null;
}

/**
 * The manager instance, once the cell has one.
 *
 * A cell is created synchronously by `spawn` and its actor a moment later, so
 * a bare read races the spawn — polling on the strongest observable state
 * (the instance itself) rather than sleeping is what keeps this from flaking
 * on a loaded machine.
 */
async function manager(node: Node): Promise<ManagerInternals> {
  await awaitCondition(() => managerInstance(node) !== null, {
    timeoutMs: 4_000,
    label: 'the singleton manager instance was constructed',
  });
  return managerInstance(node)!;
}

describe('start() layers actor-ts.cluster.singleton under the caller (#855)', () => {
  test('every configured field reaches the manager the extension builds', async () => {
    const node = await startNode('sng-config-start', 48_511, `
      actor-ts.cluster.singleton {
        role                      = "backend"
        hand-over-timeout         = 3s
        acquire-retry-interval    = 1500ms
        max-hand-over-state-bytes = 64K
        restart-on-termination    = off
      }
    `);

    node.cluster.singleton.start(WorkerActor);

    // `ensureManager`'s copy is field-by-field and silently drops anything not
    // listed, so asserting the whole set is what catches a field that reaches
    // the merged options and stops there.
    expect((await manager(node)).options).toMatchObject({
      role: 'backend',
      handOverTimeoutMs: 3_000,
      acquireRetryIntervalMs: 1_500,
      maxHandOverStateBytes: 65_536,
      restartOnTermination: false,
    });
  });

  test('an explicit option beats the configured one, per field', async () => {
    const node = await startNode('sng-config-precedence', 48_512, `
      actor-ts.cluster.singleton {
        role              = "backend"
        hand-over-timeout = 3s
      }
    `);

    const options = StartSingletonOptions.create<string>()
      .withTypeName(TYPE_NAME)
      .withActor(WorkerActor)
      .withHandOverTimeoutMs(7_000);
    node.cluster.singleton.start(options);

    // Per field, not per object: the explicit `handOverTimeoutMs` wins and the
    // configured `role` still falls through beside it.
    expect((await manager(node)).options).toMatchObject({ role: 'backend', handOverTimeoutMs: 7_000 });
  });

  test('a role declared on the actor class beats the configured one', async () => {
    // Backwards from the "config file wins" intuition, and right: the key is
    // code, and `shorthandOptions` folds it into the explicit layer before the
    // merge ever runs.
    class KeyedWorkerActor extends Actor<string> {
      static readonly singleton = SingletonKey.of<string>(TYPE_NAME, 'edge');
      override onReceive(): void { /* placement only */ }
    }

    const node = await startNode(
      'sng-config-key-role',
      48_513,
      'actor-ts.cluster.singleton.role = "backend"',
    );
    node.cluster.singleton.start(KeyedWorkerActor);

    expect((await manager(node)).options.role).toBe('edge');
  });

  test('the merge runs before the validator, so a bad configured value is refused by name', async () => {
    // Ordering, asserted through the one consequence that cannot be faked: a
    // value that only ever existed in a config file has to be the one the
    // validator rejects.  Merging *after* validation would let it through and
    // arm a zero-length timer instead.
    const node = await startNode(
      'sng-config-validated',
      48_514,
      'actor-ts.cluster.singleton.hand-over-timeout = 0s',
    );

    expect(() => node.cluster.singleton.start(WorkerActor)).toThrow(OptionsError);
    expect(() => node.cluster.singleton.start(WorkerActor)).toThrow(/handOverTimeoutMs/);
  });
});

describe('ref() reads the block too — the proxy-only node (#855)', () => {
  test('a configured role and buffer cap both reach a ref()-only proxy', async () => {
    const node = await startNode('sng-config-ref', 48_515, `
      actor-ts.cluster.singleton {
        role        = "backend"
        buffer-size = 2
      }
    `);

    // The node declares no roles, so no member carries `backend` and
    // `singletonHost` finds nobody — which is what routes these sends into the
    // buffer rather than into `onMissingHost`'s dead letters.
    const proxy = node.cluster.singleton.ref<string>(TYPE_NAME) as unknown as ClusterSingletonProxy<string>;
    for (let i = 0; i < 5; i++) proxy.tell(`m${i}`);

    // Both halves are load-bearing and each fails differently.  Without the
    // configured ROLE this node is its own leader, so every send would take
    // `deliver` → `onMissingHost` → dead letters and `droppedCount` would stay
    // 0.  Without the configured BUFFER SIZE the cap would be the built-in
    // 1000, so all five would be held and `droppedCount` would again be 0.
    expect(proxy.hasPending()).toBe(true);
    expect(proxy.droppedCount).toBe(3);
  });

  test('a role on the key still wins over the configured one on the ref() path', async () => {
    const node = await startNode(
      'sng-config-ref-key-role',
      48_516,
      'actor-ts.cluster.singleton.role = "backend"',
    );

    const key = SingletonKey.of<string>(TYPE_NAME, 'edge');
    const proxy = node.cluster.singleton.ref<string>(key) as unknown as ClusterSingletonProxy<string>;

    // Read back through `_adoptRole`, which keeps the first role and warns on a
    // conflicting second: adopting `backend` is a no-op iff the proxy already
    // holds `edge`, and the private field is what says which.
    expect((proxy as unknown as { role?: string }).role).toBe('edge');
  });

  test('with no configured role a ref()-only node still routes at the leader', async () => {
    // The control for the buffering case above, and the assertion that the new
    // `ref()` read is *narrow*: an empty `role` placeholder must not turn every
    // unconfigured proxy into one that considers nobody a host.
    const node = await startNode('sng-config-ref-unset', 48_517, 'actor-ts.cluster.singleton.buffer-size = 2');

    const proxy = node.cluster.singleton.ref<string>(TYPE_NAME) as unknown as ClusterSingletonProxy<string>;
    proxy.tell('m0');

    expect((proxy as unknown as { role?: string }).role).toBeUndefined();
    expect(proxy.hasPending()).toBe(false);
    expect(proxy.droppedCount).toBe(0);
  });
});
