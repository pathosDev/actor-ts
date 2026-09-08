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
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

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

type Node = { readonly system: ActorSystem; readonly cluster: Cluster; readonly log: RecordingLogger };

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
  // A recording logger rather than a `NoopLogger`: it is as quiet (nothing
  // reaches a console) and it is the only instrument that can assert the
  // *absence* of the misconfiguration warning, which is half of what role
  // precedence promises.
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create().withLogger(log);
  if (hocon !== undefined) systemOptions.withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(name, systemOptions);

  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(50);
  const cluster = await Cluster.join(system, clusterOptions);

  const node: Node = { system, cluster, log };
  running = node;
  return node;
}

/** The role a proxy will actually resolve its host with — a private field. */
function proxyRole(ref: unknown): string | undefined {
  return (ref as { role?: string }).role;
}

/** Every warning this node emitted about being addressed with two roles. */
function conflictWarnings(node: Node): readonly string[] {
  return node.log.records
    .filter((record) => record.level === 'warn' && record.message.includes('conflicting role'))
    .map((record) => record.message);
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

  test('a role declared on the actor class beats the configured one, with the block still read', async () => {
    // Backwards from the "config file wins" intuition, and right: the key is
    // code, and `shorthandOptions` folds it into the explicit layer before the
    // merge ever runs.
    class KeyedWorkerActor extends Actor<string> {
      static readonly singleton = SingletonKey.of<string>(TYPE_NAME, 'edge');
      override onReceive(): void { /* placement only */ }
    }

    const node = await startNode('sng-config-key-role', 48_513, `
      actor-ts.cluster.singleton {
        role              = "backend"
        hand-over-timeout = 3s
      }
    `);
    node.cluster.singleton.start(KeyedWorkerActor);

    // `handOverTimeoutMs` is the witness, and it is what makes this a
    // *precedence* assertion rather than a tautology: the key-declared role
    // reaches the manager whether or not the config layer is merged at all, so
    // on its own `role: 'edge'` also passes with `withConfigDefaults` deleted.
    // A second field that can only have come from the file says the losing
    // layer was genuinely consulted and genuinely lost.
    expect((await manager(node)).options).toMatchObject({ role: 'edge', handOverTimeoutMs: 3_000 });
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

  test('a role on the key still wins over the configured one on the ref() path, with the block still read', async () => {
    const node = await startNode('sng-config-ref-key-role', 48_516, `
      actor-ts.cluster.singleton {
        role        = "backend"
        buffer-size = 2
      }
    `);

    const key = SingletonKey.of<string>(TYPE_NAME, 'edge');
    const proxy = node.cluster.singleton.ref<string>(key) as unknown as ClusterSingletonProxy<string>;
    for (let i = 0; i < 5; i++) proxy.tell(`m${i}`);

    // The role assertion alone is a tautology — a key that carries a role never
    // enters the branch that consults the file, so it also passes with the
    // whole `ref()` config read deleted.  The buffer cap is the witness that
    // the read happened: three of five dropped is the configured `2`, where the
    // built-in `1000` would have held all five.
    expect(proxyRole(proxy)).toBe('edge');
    expect(proxy.droppedCount).toBe(3);
  });

  test('with no configured role a ref()-only node still routes at the leader', async () => {
    // The control for the buffering case above, and the assertion that the new
    // `ref()` read is *narrow*: an empty `role` placeholder must not turn every
    // unconfigured proxy into one that considers nobody a host.
    const node = await startNode('sng-config-ref-unset', 48_517, 'actor-ts.cluster.singleton.buffer-size = 2');

    const proxy = node.cluster.singleton.ref<string>(TYPE_NAME) as unknown as ClusterSingletonProxy<string>;
    proxy.tell('m0');

    expect(proxyRole(proxy)).toBeUndefined();
    expect(proxy.hasPending()).toBe(false);
    expect(proxy.droppedCount).toBe(0);
  });
});

/**
 * Precedence is a property of the *layers*, not of the call order (#855).
 *
 * The proxy is memoised per `typeName` and both doors reach the same instance,
 * so whichever of `ref()` and `start()` runs first decides which role the proxy
 * is constructed with.  That is only harmless while the two roles are peers —
 * and they are not: one comes from code, the other from a file the project
 * documents as the lower layer.  A proxy that keeps whichever arrived first
 * inverts `explicit > HOCON` for exactly one of the two orderings, and then
 * routes at a different host class than this node's own manager.
 *
 * Each test below therefore asserts on **both** ends — the proxy's role and the
 * manager's — because agreeing with each other is the property that matters;
 * a proxy that is right about a singleton the local manager hosts elsewhere is
 * still the #637 divergence.
 */
describe('an explicit role wins over a configured one in either call order (#855)', () => {
  test('a role on the options replaces the configured one a ref() adopted first', async () => {
    const node = await startNode(
      'sng-role-ref-then-options',
      48_518,
      'actor-ts.cluster.singleton.role = "backend"',
    );

    // The ordering that matters: the proxy exists, holding the configured role,
    // before the call that carries the explicit one.
    const proxy = node.cluster.singleton.ref<string>(TYPE_NAME) as unknown as ClusterSingletonProxy<string>;
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName(TYPE_NAME)
      .withActor(WorkerActor)
      .withRole('edge');
    node.cluster.singleton.start(singletonOptions);

    expect((await manager(node)).options.role).toBe('edge');
    expect(proxyRole(proxy)).toBe('edge');
    expect(conflictWarnings(node)).toEqual([]);
  });

  test('a role on the actor class key replaces the configured one a ref() adopted first', async () => {
    class KeyedWorkerActor extends Actor<string> {
      static readonly singleton = SingletonKey.of<string>(TYPE_NAME, 'edge');
      override onReceive(): void { /* placement only */ }
    }

    const node = await startNode(
      'sng-role-ref-then-key',
      48_519,
      'actor-ts.cluster.singleton.role = "backend"',
    );

    // `ref(TYPE_NAME)` and not `ref(KeyedWorkerActor)`: the bare type name is
    // the shape with no role of its own, which is what lets the file's role
    // reach the proxy first and is the whole hazard the docs' "put the role on
    // the key and every node agrees by construction" has to survive.
    const proxy = node.cluster.singleton.ref<string>(TYPE_NAME) as unknown as ClusterSingletonProxy<string>;
    node.cluster.singleton.start(KeyedWorkerActor);

    expect((await manager(node)).options.role).toBe('edge');
    expect(proxyRole(proxy)).toBe('edge');
    expect(conflictWarnings(node)).toEqual([]);
  });

  test('a configured role arriving after an explicit one is precedence, not a conflict', async () => {
    const node = await startNode(
      'sng-role-options-then-ref',
      48_520,
      'actor-ts.cluster.singleton.role = "backend"',
    );

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName(TYPE_NAME)
      .withActor(WorkerActor)
      .withRole('edge');
    node.cluster.singleton.start(singletonOptions);
    const proxy = node.cluster.singleton.ref<string>(TYPE_NAME) as unknown as ClusterSingletonProxy<string>;

    // Routing was already right in this order.  What was wrong is the sentence
    // the operator reads: a configured role losing to an explicit one is the
    // documented precedence resolving, and telling them their deployment is
    // impossible sends them to fix a file that is doing its job.
    expect(proxyRole(proxy)).toBe('edge');
    expect(conflictWarnings(node)).toEqual([]);
  });

  test('two explicit roles are still a conflict, warned about, and the first still wins', async () => {
    // The warning has to survive the fix, or the repair would have removed the
    // only signal for the misconfiguration it was written for: one singleton
    // restricted two ways, both times by code, is not resolvable by precedence.
    const node = await startNode('sng-role-two-explicit', 48_521);

    const proxy = node.cluster.singleton.ref<string>(
      SingletonKey.of<string>(TYPE_NAME, 'edge'),
    ) as unknown as ClusterSingletonProxy<string>;
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName(TYPE_NAME)
      .withActor(WorkerActor)
      .withRole('backend');
    node.cluster.singleton.start(singletonOptions);

    expect(proxyRole(proxy)).toBe('edge');
    expect(conflictWarnings(node)).toHaveLength(1);
    expect(conflictWarnings(node)[0]).toContain("ignoring conflicting role 'backend'");
  });
});
