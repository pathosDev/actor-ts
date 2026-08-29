import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { Config } from '../../../src/config/Config.js';
import {
  Listing,
  Receptionist,
  ReceptionistId,
  ReceptionistOptions,
  Register,
  ServiceKey,
  Subscribe,
  SubscribeRejected,
  Unsubscribe,
} from '../../../src/discovery/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #137 — the subscriber set used to be an uncapped `Set` that nothing ever
 * pruned, so a buggy or hostile actor could grow it forever and every
 * registration change then walked it.  Two mechanisms bound it now, and both
 * are covered here: caps that refuse *out loud* with `SubscribeRejected`, and
 * death watch that reclaims a slot when a subscriber stops without
 * unsubscribing.
 *
 * Single-node throughout (`start(null)`): none of this involves gossip, and a
 * real cluster would only add convergence timing to assertions that are about
 * bookkeeping.
 */

const newKit = (name: string): TestKit => {
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return TestKit.create(name, kitOptions);
};

/** A subscriber that can actually be stopped — a TestProbe is a bare ref. */
class Subscriber extends Actor<unknown> {
  override onReceive(): void {}
}

/**
 * Read-only view of the actor's private key map, so the "a refused subscribe
 * leaves nothing behind" assertion can look at the thing it is about.  The
 * public protocol deliberately cannot see an empty key entry — dropping it is
 * the point — so there is nothing else to assert against.
 */
interface ReceptionistInternals {
  readonly keys: Map<string, unknown>;
  /**
   * keyId ↔ subscriber path (#1037).  `size` — the pair count — is what the
   * total cap reads, which is why it is named `maxSubscriptionsTotal` (#1200).
   */
  readonly subscriptions: BidirectionalMultiMap<string, string>;
  readonly subscriberRefs: Map<string, unknown>;
}

describe('Receptionist — subscriber caps (#137)', () => {
  test('a Subscribe past maxSubscribersPerKey is answered with SubscribeRejected', async () => {
    const kit = newKit('recp-cap-key');
    const receptionistOptions = ReceptionistOptions.create()
      .withMaxSubscribersPerKey(2)
      .withMaxSubscriptionsTotal(100);
    const receptionist = kit.system.extension(ReceptionistId).start(null, receptionistOptions);
    const key = ServiceKey.of<string>('capped');

    const first = kit.createTestProbe();
    const second = kit.createTestProbe();
    receptionist.tell(new Subscribe(key, first));
    receptionist.tell(new Subscribe(key, second));
    await first.expectMessageType(Listing, 500);
    await second.expectMessageType(Listing, 500);

    const third = kit.createTestProbe();
    receptionist.tell(new Subscribe(key, third));
    const rejected = await third.expectMessageType(SubscribeRejected, 500);
    expect(rejected.key.id).toBe('capped');
    expect(rejected.reason).toBe('maxSubscribersPerKey');
    expect(rejected.limit).toBe(2);

    // The refusal is total: the rejected subscriber gets no listings either.
    receptionist.tell(new Register(key, kit.system.spawn(Subscriber, 'svc')));
    await first.expectMessageType(Listing, 500);
    await third.expectNoMessage(60);

    await kit.system.terminate();
  });

  test('maxSubscriptionsTotal counts across keys and names itself in the refusal', async () => {
    const kit = newKit('recp-cap-total');
    const receptionistOptions = ReceptionistOptions.create()
      .withMaxSubscribersPerKey(50)
      .withMaxSubscriptionsTotal(2);
    const receptionist = kit.system.extension(ReceptionistId).start(null, receptionistOptions);

    const first = kit.createTestProbe();
    const second = kit.createTestProbe();
    receptionist.tell(new Subscribe(ServiceKey.of<string>('alpha'), first));
    receptionist.tell(new Subscribe(ServiceKey.of<string>('beta'), second));
    await first.expectMessageType(Listing, 500);
    await second.expectMessageType(Listing, 500);

    // A third subscriber on a third key: the per-key cap has plenty of room,
    // so only the total can be what refuses it.
    const third = kit.createTestProbe();
    receptionist.tell(new Subscribe(ServiceKey.of<string>('gamma'), third));
    const rejected = await third.expectMessageType(SubscribeRejected, 500);
    expect(rejected.reason).toBe('maxSubscriptionsTotal');
    expect(rejected.limit).toBe(2);

    await kit.system.terminate();
  });

  test('one subscriber on three keys spends three of the total (#1200)', async () => {
    // The distinction the rest of this block is blind to: every other total-cap
    // case here gives each subscriber exactly one key, so pairs and subscribers
    // coincide and the assertions hold whichever the cap counts.  This one
    // separates them — a single subscriber, four keys, a cap of three — and so
    // it is the case that would fail if the check ever moved to the
    // distinct-subscriber count the option used to be named after.  Which is not
    // a hypothetical: that count is now one getter away.
    const kit = newKit('recp-cap-pairs');
    const receptionistOptions = ReceptionistOptions.create()
      .withMaxSubscribersPerKey(50)
      .withMaxSubscriptionsTotal(3);
    const receptionist = kit.system.extension(ReceptionistId).start(null, receptionistOptions);

    const solo = kit.createTestProbe();
    for (const id of ['alpha', 'beta', 'gamma']) {
      receptionist.tell(new Subscribe(ServiceKey.of<string>(id), solo));
      await solo.expectMessageType(Listing, 500);
    }

    // The per-key cap has 49 slots free on every key, so only the total can
    // refuse this — and it refuses a subscriber the receptionist already knows.
    receptionist.tell(new Subscribe(ServiceKey.of<string>('delta'), solo));
    const rejected = await solo.expectMessageType(SubscribeRejected, 500);
    expect(rejected.reason).toBe('maxSubscriptionsTotal');
    expect(rejected.limit).toBe(3);

    await kit.system.terminate();
  });

  test('unsubscribing frees a slot the total cap was holding', async () => {
    const kit = newKit('recp-cap-release');
    const receptionistOptions = ReceptionistOptions.create().withMaxSubscriptionsTotal(1);
    const receptionist = kit.system.extension(ReceptionistId).start(null, receptionistOptions);
    const key = ServiceKey.of<string>('one-at-a-time');

    const holder = kit.createTestProbe();
    receptionist.tell(new Subscribe(key, holder));
    await holder.expectMessageType(Listing, 500);

    const waiting = kit.createTestProbe();
    receptionist.tell(new Subscribe(key, waiting));
    await waiting.expectMessageType(SubscribeRejected, 500);

    receptionist.tell(new Unsubscribe(key, holder));
    receptionist.tell(new Subscribe(key, waiting));
    await waiting.expectMessageType(Listing, 500);

    await kit.system.terminate();
  });

  test('a stopped subscriber is dropped by death watch, freeing its slot', async () => {
    const kit = newKit('recp-death-watch');
    const receptionistOptions = ReceptionistOptions.create().withMaxSubscribersPerKey(1);
    const receptionist = kit.system.extension(ReceptionistId).start(null, receptionistOptions);
    const key = ServiceKey.of<string>('watched');

    // A real actor, not a probe: only a spawned actor can terminate, and
    // `Terminated` is the whole mechanism under test.
    const doomed = kit.system.spawn(Subscriber, 'doomed');
    const waiting = kit.createTestProbe();
    // Mailbox order makes this deterministic — `doomed` takes the only slot,
    // so the probe behind it must be refused.
    receptionist.tell(new Subscribe(key, doomed));
    receptionist.tell(new Subscribe(key, waiting));
    await waiting.expectMessageType(SubscribeRejected, 500);

    doomed.stop();

    // The slot comes back once `Terminated` has been processed.  Retrying the
    // subscribe *is* the probe: there is no other observable for "the stopped
    // subscriber is gone", and a fixed sleep would only guess at when.
    let accepted: unknown = null;
    await awaitCondition(async () => {
      receptionist.tell(new Subscribe(key, waiting));
      const reply = await waiting.receiveOne(1_000);
      if (reply instanceof Listing) { accepted = reply; return true; }
      return false;
    }, { timeoutMs: 4_000, intervalMs: 25, label: 'death watch released the stopped subscriber' });
    expect(accepted).toBeInstanceOf(Listing);

    await kit.system.terminate();
  });

  test('HOCON supplies the cap, and an explicit option still outranks it (#857)', async () => {
    // The end of the wire the reader test cannot reach: a key that parses but
    // never reaches the actor is the exact defect the dead-key guard is about.
    const cappedConfig = Config.parseString('actor-ts.cluster.receptionist.max-subscribers-per-key = 1');
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(cappedConfig);
    const kit = TestKit.create('recp-hocon-cap', kitOptions);
    const receptionist = kit.system.extension(ReceptionistId).start(null);
    const key = ServiceKey.of<string>('from-config');

    const holder = kit.createTestProbe();
    const waiting = kit.createTestProbe();
    receptionist.tell(new Subscribe(key, holder));
    receptionist.tell(new Subscribe(key, waiting));
    await holder.expectMessageType(Listing, 500);
    const rejected = await waiting.expectMessageType(SubscribeRejected, 500);
    expect(rejected.limit).toBe(1);

    await kit.system.terminate();

    // Same config, but the caller says otherwise — explicit options win.
    const overridden = TestKit.create('recp-hocon-override', kitOptions);
    const receptionistOptions = ReceptionistOptions.create().withMaxSubscribersPerKey(2);
    const loose = overridden.system.extension(ReceptionistId).start(null, receptionistOptions);
    const one = overridden.createTestProbe();
    const two = overridden.createTestProbe();
    loose.tell(new Subscribe(key, one));
    loose.tell(new Subscribe(key, two));
    await one.expectMessageType(Listing, 500);
    await two.expectMessageType(Listing, 500);

    await overridden.system.terminate();
  });

  test('a refused Subscribe does not leave an empty key entry behind', async () => {
    // The cap bounds what one entry holds; without this the flood just moves
    // one level up and grows the key map instead.
    const kit = newKit('recp-cap-no-residue');
    let captured: Receptionist | null = null;
    const receptionistOptions = ReceptionistOptions.create().withMaxSubscriptionsTotal(1);
    const receptionist = kit.system.spawn(() => {
      captured = new Receptionist(receptionistOptions);
      return captured;
    }, 'capped-receptionist');
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'the receptionist instance was captured',
    });
    const internals = captured! as unknown as ReceptionistInternals;

    const holder = kit.createTestProbe();
    receptionist.tell(new Subscribe(ServiceKey.of<string>('held'), holder) as never);
    await holder.expectMessageType(Listing, 500);

    const refused = kit.createTestProbe();
    for (let i = 0; i < 25; i++) {
      receptionist.tell(new Subscribe(ServiceKey.of<string>(`flood-${i}`), refused) as never);
    }
    await awaitCondition(() => refused.messageCount === 25, {
      timeoutMs: 4_000, intervalMs: 25, label: 'all twenty-five subscribes were refused',
    });

    // Only the one accepted subscription's key survives.
    expect(internals.keys.size).toBe(1);
    // …and the relation agrees: one pair, one subscriber, one key.
    expect(internals.subscriptions.size).toBe(1);
    expect([...internals.subscriptions.lefts()]).toEqual(['held']);
    expect(internals.subscriberRefs.size).toBe(1);

    await kit.system.terminate();
  });

  test('a stopped subscriber leaves no trace in either direction (#1037)', async () => {
    // The acceptance criterion of #1037, checked at a real call site rather
    // than only in the collection's own suite: removing a participant from one
    // side must leave nothing referring to it on the other.  The cap tests
    // above only prove a *slot* came back, which a stale reverse entry would
    // survive.
    const kit = newKit('recp-no-residue');
    let captured: Receptionist | null = null;
    const receptionist = kit.system.spawn(() => {
      captured = new Receptionist();
      return captured;
    }, 'watched-receptionist');
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'the receptionist instance was captured',
    });
    const internals = captured! as unknown as ReceptionistInternals;

    const doomed = kit.system.spawn(Subscriber, 'doomed-multi');
    receptionist.tell(new Subscribe(ServiceKey.of<string>('alpha'), doomed) as never);
    receptionist.tell(new Subscribe(ServiceKey.of<string>('beta'), doomed) as never);
    await awaitCondition(() => internals.subscriptions.size === 2, {
      timeoutMs: 4_000, intervalMs: 25, label: 'both subscriptions were booked',
    });
    // One subscriber over two keys — watched once, and the ref stored once.
    expect(internals.subscriberRefs.size).toBe(1);

    doomed.stop();

    await awaitCondition(() => internals.subscriptions.size === 0, {
      timeoutMs: 4_000, intervalMs: 25, label: 'death watch cleared both subscriptions',
    });
    const path = doomed.path.toString();
    expect(internals.subscriptions.hasRight(path)).toBe(false);
    expect([...internals.subscriptions.lefts()]).toEqual([]);
    expect([...internals.subscriptions.rights()]).toEqual([]);
    // The sidecar follows the relation, and the key entries go with the last
    // thing that held them.
    expect(internals.subscriberRefs.size).toBe(0);
    expect(internals.keys.size).toBe(0);

    await kit.system.terminate();
  });
});
