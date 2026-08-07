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
}

describe('Receptionist — subscriber caps (#137)', () => {
  test('a Subscribe past maxSubscribersPerKey is answered with SubscribeRejected', async () => {
    const kit = newKit('recp-cap-key');
    const receptionistOptions = ReceptionistOptions.create()
      .withMaxSubscribersPerKey(2)
      .withMaxSubscribersTotal(100);
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

  test('maxSubscribersTotal counts across keys and names itself in the refusal', async () => {
    const kit = newKit('recp-cap-total');
    const receptionistOptions = ReceptionistOptions.create()
      .withMaxSubscribersPerKey(50)
      .withMaxSubscribersTotal(2);
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
    expect(rejected.reason).toBe('maxSubscribersTotal');
    expect(rejected.limit).toBe(2);

    await kit.system.terminate();
  });

  test('unsubscribing frees a slot the total cap was holding', async () => {
    const kit = newKit('recp-cap-release');
    const receptionistOptions = ReceptionistOptions.create().withMaxSubscribersTotal(1);
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
    const receptionistOptions = ReceptionistOptions.create().withMaxSubscribersTotal(1);
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

    await kit.system.terminate();
  });
});
