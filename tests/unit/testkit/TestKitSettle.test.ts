import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { TestKit } from '../../../src/testkit/TestKit.js';

/**
 * #1025 / #1424 — `advance` fires a timer synchronously; its effects land later.
 *
 * The two `ManualScheduler` samples in the documentation were written as
 *
 *     scheduler.advance(100);
 *     await probe.expectMessage('tick');
 *
 * and the probe's own real-time timeout was quietly doing the settling. Where a
 * test asserted synchronously instead, it read an empty probe. Virtual time
 * makes *when* a timer fires deterministic and says nothing at all about when
 * the `tell` it performed has been delivered.
 *
 * `kit.advance` is both halves in the right order, and neither half sleeps.
 */

/** Records what it is told, so an assertion can be synchronous. */
class Recorder extends Actor<string> {
  static readonly seen: string[] = [];
  override onReceive(message: string): void { Recorder.seen.push(message); }
}

/**
 * Re-sends to itself every turn, so the `/user` tree is never quiet.
 *
 * The case the turn budget exists for. `stopped` is a static rather than a
 * message so the volley can be halted without queueing behind the flood it is
 * trying to stop, which would make teardown a race.
 */
class Perpetual extends Actor<string> {
  static stopped = false;
  override onReceive(message: string): void {
    if (!Perpetual.stopped) this.context.self.tell(message);
  }
}

/** Forwards to a second actor, so settling has to be transitive to work. */
class Relay extends Actor<string> {
  override onReceive(message: string): void {
    this.context.actorSelection('/user/recorder').tell(`relayed:${message}`);
  }
}

describe('TestKit.advance settles the effects it triggers', () => {
  test('a scheduled tell has landed by the time advance resolves', async () => {
    Recorder.seen.length = 0;
    const { kit, scheduler } = TestKit.withManualScheduler('settle-tick');
    try {
      const recorder = kit.system.spawn(Recorder, 'recorder');
      scheduler.scheduleOnce(100, recorder, 'tick');

      // The shape the samples used, and the reason they did not work: the timer
      // has fired and the message has not been delivered.
      scheduler.advance(100);
      expect(Recorder.seen).toEqual([]);

      await kit.settle();
      expect(Recorder.seen).toEqual(['tick']);
    } finally {
      await kit.shutdown();
    }
  });

  test('advance does both halves, so the assertion can follow it directly', async () => {
    Recorder.seen.length = 0;
    const { kit } = TestKit.withManualScheduler('settle-advance');
    try {
      const recorder = kit.system.spawn(Recorder, 'recorder');
      kit.system.scheduler.scheduleOnce(250, recorder, 'later');

      await kit.advance(250);
      expect(Recorder.seen).toEqual(['later']);
    } finally {
      await kit.shutdown();
    }
  });

  test('settling is transitive across a hop between two actors', async () => {
    // The relay's turn arms the recorder's, and both land in one settle.  Not
    // because the settle yields twice — measured, one yield is enough, because
    // the default dispatcher spends a microtask budget before yielding — but
    // because "quiet" is asked of the whole `/user` tree rather than of the
    // actor that was told.
    Recorder.seen.length = 0;
    const { kit } = TestKit.withManualScheduler('settle-relay');
    try {
      kit.system.spawn(Recorder, 'recorder');
      const relay = kit.system.spawn(Relay, 'relay');
      kit.system.scheduler.scheduleOnce(10, relay, 'hop');

      await kit.advance(10);
      expect(Recorder.seen).toEqual(['relayed:hop']);
    } finally {
      await kit.shutdown();
    }
  });

  test('settle works after a plain tell, with no timer involved', async () => {
    Recorder.seen.length = 0;
    const kit = TestKit.create('settle-tell');
    try {
      const recorder = kit.system.spawn(Recorder, 'recorder');
      recorder.tell('direct');
      expect(Recorder.seen).toEqual([]);

      await kit.settle();
      expect(Recorder.seen).toEqual(['direct']);
    } finally {
      await kit.shutdown();
    }
  });

  test('a whole virtual minute of ticks settles in one advance', async () => {
    Recorder.seen.length = 0;
    const { kit } = TestKit.withManualScheduler('settle-many');
    try {
      const recorder = kit.system.spawn(Recorder, 'recorder');
      kit.system.scheduler.scheduleAtFixedRate(1_000, 1_000, recorder, 'beat');

      await kit.advance(60_000);
      expect(Recorder.seen).toHaveLength(60);
    } finally {
      await kit.shutdown();
    }
  });

  test('an exchange that never becomes quiet fails rather than hanging', async () => {
    // What the turn budget is for, and the only thing it is for: one yield
    // settles every ordinary case in this suite, so the ceiling is not sized
    // for depth. Without it this drains forever, and bun's per-test timeout
    // does not rescue a loop that keeps yielding (#1360).
    Perpetual.stopped = false;
    const kit = TestKit.create('settle-perpetual');
    try {
      const looper = kit.system.spawn(Perpetual, 'looper');
      looper.tell('again');
      await expect(kit.settle()).rejects.toThrow(/still busy after the turn budget/);
    } finally {
      Perpetual.stopped = true;
      await kit.shutdown();
    }
  }, 15_000);

  test('advance refuses a kit that has no virtual time to advance', async () => {
    // Silently doing nothing would make whatever assertion follows a coin flip.
    const kit = TestKit.create('settle-no-scheduler');
    try {
      await expect(kit.advance(100)).rejects.toThrow(/no ManualScheduler/);
    } finally {
      await kit.shutdown();
    }
  });
});
