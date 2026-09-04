/**
 * The same two questions as `UntrustedWireMode.test.ts`, at the other entry
 * point — and the more exposed one (#877, #964).
 *
 * A `ClusterClient` speaks the cluster wire without ever joining the membership
 * ring, and a contact point is by design reachable from outside whatever
 * boundary protects the cluster's own links.  Its path parser also went one
 * step further than `Cluster`'s did: `GUARDIAN_SEGMENTS` admits `system` on
 * purpose, so an outside caller could name a framework actor and reach it
 * through generic path resolution.  The issue body does not mention this seam
 * at all; it is the half worth having.
 *
 * Two properties are pinned, and the second is the one an implementation is
 * likely to get wrong:
 *
 *  - a refused path is not delivered, is counted, and is counted under this
 *    seam's own `frame` label;
 *  - a refusal and a genuine miss are **indistinguishable to the client**.
 *    Two answers an outside caller could tell apart would turn this endpoint
 *    into an existence oracle for the actor tree, which is a better exploit
 *    than the one being closed.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import {
  ClusterClientReceptionistId,
  type ClusterClientEnvelopeMessage,
  type ClusterClientReplyMessage,
} from '../../../src/cluster/ClusterClientReceptionist.js';
import { EnvelopeTrust } from '../../../src/cluster/EnvelopeTrust.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** Records every body it was told, so "never arrived" is assertable. */
class Recorder extends Actor<unknown> {
  constructor(private readonly seen: unknown[]) { super(); }

  override onReceive(message: unknown): void {
    this.seen.push(message);
    this.sender.forEach((s) => s.tell('ok'));
  }
}

/**
 * The four things the receptionist touches on a `Cluster`, with a **real**
 * `EnvelopeTrust` rather than a permissive stub — a fake that admitted
 * everything would make every assertion in this file vacuous.
 */
class FakeCluster {
  readonly sent: ClusterClientReplyMessage[] = [];
  readonly _envelopeTrust: EnvelopeTrust;
  private handler: ((message: WireMessage, from: NodeAddress) => void) | null = null;

  readonly transport = {
    send: (_to: NodeAddress, message: WireMessage): void => {
      this.sent.push(message as unknown as ClusterClientReplyMessage);
    },
  };

  constructor(
    readonly selfAddress: NodeAddress,
    system: ActorSystem,
    untrustedMode: boolean,
    trustedSelectionPaths: readonly string[],
  ) {
    this._envelopeTrust =
      new EnvelopeTrust(system, new NoopLogger(), untrustedMode, trustedSelectionPaths);
  }

  _onWire(_kind: string, handler: (message: WireMessage, from: NodeAddress) => void): () => void {
    this.handler = handler;
    return (): void => { this.handler = null; };
  }

  deliver(envelope: ClusterClientEnvelopeMessage, from: NodeAddress): void {
    if (!this.handler) throw new Error('no wire handler registered');
    this.handler(envelope as unknown as WireMessage, from);
  }
}

const CLIENT = new NodeAddress('cluster-client', '203.0.113.9', 51_000);

type Fixture = {
  readonly system: ActorSystem;
  readonly cluster: FakeCluster;
  readonly user: unknown[];
  readonly framework: unknown[];
  readonly frameworkPath: string;
};

function startFixture(
  name: string,
  untrustedMode = false,
  trustedSelectionPaths: readonly string[] = [],
  spawnFramework = true,
): Fixture {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  // A real registry, or every counter here is the noop whose `value` is a
  // constant 0 — a zero assertion against it passes whatever the code does.
  system.extension(MetricsExtensionId).enable();
  const user: unknown[] = [];
  const framework: unknown[] = [];
  system.spawn(() => new Recorder(user), 'orders');
  const frameworkRef = spawnFramework
    ? system._spawnSystemActor(() => new Recorder(framework), 'cluster', 'pretend-coordinator')
    : null;
  const cluster = new FakeCluster(
    new NodeAddress(name, '10.0.0.5', 2_552), system, untrustedMode, trustedSelectionPaths,
  );
  system.extension(ClusterClientReceptionistId).start(cluster as unknown as Cluster);
  // The literal fallback is what the spawned ref renders to — which the
  // byte-for-byte reply comparison below would catch if the two ever diverged.
  const frameworkPath = frameworkRef?.path.toString()
    ?? `actor-ts://${name}/system/cluster/pretend-coordinator`;
  return { system, cluster, user, framework, frameworkPath };
}

const refusals = (
  fixture: Fixture,
  reason: 'system-path' | 'not-allow-listed',
): number => metricsOf(fixture.system)
  .counter('cluster_envelope_refusals_total', { reason, frame: 'cluster-client-envelope' })
  .value;

const awaitReply = (fixture: Fixture): Promise<void> =>
  awaitCondition(() => fixture.cluster.sent.length > 0, {
    label: 'the receptionist sent a cluster-client-reply',
  });

describe('a cluster client cannot reach /system by name (#964)', () => {
  test('a tell to a framework actor is refused, counted, and never delivered', async () => {
    const fixture = startFixture('receptionist-scope-system-tell');
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      to: fixture.frameworkPath,
      body: { kind: 'seize-everything' },
    }, CLIENT);

    await awaitCondition(() => refusals(fixture, 'system-path') === 1, {
      label: 'the /system tell was counted as refused',
    });
    expect(fixture.framework).toEqual([]);
    await fixture.system.terminate();
  });

  test('the bare `system/...` spelling the parser accepts is refused too', async () => {
    // `GUARDIAN_SEGMENTS` still lists `system`, deliberately: parsing it as a
    // guardian is what makes this a counted refusal instead of a silent lookup
    // for a *user* actor literally called `system`.
    const fixture = startFixture('receptionist-scope-system-bare');
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      to: 'system/cluster/pretend-coordinator',
      body: {},
    }, CLIENT);

    await awaitCondition(() => refusals(fixture, 'system-path') === 1, {
      label: 'the bare system/ spelling was counted as refused',
    });
    expect(fixture.framework).toEqual([]);
    await fixture.system.terminate();
  });

  test('the ask reply does not say whether the actor was there', async () => {
    // The oracle property.  Two fixtures, the same system name and the same
    // requested path — the actor exists in one and not in the other — so any
    // difference in the reply is a difference the client can only have learned
    // from the tree.  A distinct "refused" wording would be exactly that.
    const present = startFixture('receptionist-scope-oracle');
    const absent = startFixture('receptionist-scope-oracle', false, [], false);
    const probe: ClusterClientEnvelopeMessage = {
      kind: 'cluster-client-envelope',
      to: present.frameworkPath,
      askId: 'ask-1',
      body: {},
    };

    present.cluster.deliver(probe, CLIENT);
    absent.cluster.deliver(probe, CLIENT);
    await awaitReply(present);
    await awaitReply(absent);

    expect(present.cluster.sent[0]).toEqual(absent.cluster.sent[0]!);
    expect(present.cluster.sent[0]!.ok).toBe(false);
    expect(present.framework).toEqual([]);
    await present.system.terminate();
    await absent.system.terminate();
  });
});

describe('untrusted mode narrows the client entry point too (#877)', () => {
  test('off, a /user actor is reachable by name as before', async () => {
    const fixture = startFixture('receptionist-scope-user-open');
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      to: 'orders',
      body: { kind: 'place' },
    }, CLIENT);

    await awaitCondition(() => fixture.user.length === 1, {
      label: 'the unlisted /user tell was delivered with the mode off',
    });
    expect(refusals(fixture, 'not-allow-listed')).toBe(0);
    await fixture.system.terminate();
  });

  test('on with an empty list, the same tell is refused', async () => {
    const fixture = startFixture('receptionist-scope-user-closed', true);
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      to: 'orders',
      body: { kind: 'place' },
    }, CLIENT);

    await awaitCondition(() => refusals(fixture, 'not-allow-listed') === 1, {
      label: 'the unlisted /user tell was counted as refused',
    });
    expect(fixture.user).toEqual([]);
    await fixture.system.terminate();
  });

  test('on, an allow-listed path is delivered — including the bare spelling', async () => {
    // The entry is written guardian-rooted, the way the tree renders it; what
    // the client sends is whatever spelling it likes.  Both have to land on the
    // same answer, or the allow-list would depend on the caller's formatting.
    const fixture = startFixture('receptionist-scope-user-listed', true, ['/user/orders']);
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      to: 'orders',
      body: { kind: 'place' },
    }, CLIENT);

    await awaitCondition(() => fixture.user.length === 1, {
      label: 'the allow-listed /user tell was delivered under the mode',
    });
    expect(refusals(fixture, 'not-allow-listed')).toBe(0);
    await fixture.system.terminate();
  });
});
