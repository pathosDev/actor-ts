import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** A system with the queue configured through HOCON, as an operator would. */
function newSystem(name: string, deadLetters: ConfigObject): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { 'dead-letters': deadLetters } });
  return ActorSystem.create(name, sysOptions);
}

class Nothing extends Actor<string> { override onReceive(_m: string): void {} }

/** Stop `name` and send it a message once it is genuinely gone. */
async function deadLetterTo(system: ActorSystem, name: string, message: string): Promise<void> {
  const ref = system.spawn(Nothing, name);
  ref.stop();
  // The stop has to have completed, or the message is simply delivered and
  // no dead letter is produced — the race a fixed sleep would paper over.
  await awaitCondition(() => system._resolvePath(['user', name]).isNone(), {
    timeoutMs: 4_000,
    label: `the actor '${name}' reached the terminated state`,
  });
  ref.tell(message);
}

describe('DeadLetterQueue — default behaviour is unchanged', () => {
  test('a system that configured nothing captures nothing', async () => {
    const sys = newSystem('dlq-off', {});
    try {
      expect(sys.deadLetterQueue.store).toBe('off');
      await deadLetterTo(sys, 'gone', 'lost');
      // Nothing to poll for — the property under test is that no capture
      // happens — so this settles rather than waits.
      await Bun.sleep(30);
      expect(await sys.deadLetterQueue.list()).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});

describe('DeadLetterQueue — memory store', () => {
  test('captures the letter with the recipient path and a stable id', async () => {
    const sys = newSystem('dlq-memory', { store: 'memory' });
    try {
      await deadLetterTo(sys, 'gone', 'lost');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the dead letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();
      expect(entry!.recipientPath).toBe(`actor-ts://${sys.name}/user/gone`);
      expect(entry!.payload).toEqual({ kind: 'captured', message: 'lost' });
      expect(entry!.replayCount).toBe(0);
      expect(entry!.id).not.toBe('');
      expect(await sys.deadLetterQueue.get(entry!.id)).toEqual(entry!);
    } finally {
      await sys.terminate();
    }
  });

  test('maxEntries evicts the oldest rather than growing', async () => {
    const sys = newSystem('dlq-cap', { store: 'memory', 'max-entries': 2 });
    try {
      await deadLetterTo(sys, 'a', 'first');
      await deadLetterTo(sys, 'b', 'second');
      await deadLetterTo(sys, 'c', 'third');
      await awaitCondition(async () => {
        const entries = await sys.deadLetterQueue.list();
        return entries.length === 2 && entries[0]!.payload.kind === 'captured'
          && (entries[0]!.payload as { message: unknown }).message === 'third';
      }, { timeoutMs: 4_000, label: 'the ring settled at its cap, newest first' });
      const messages = (await sys.deadLetterQueue.list())
        .map((e) => (e.payload as { message: unknown }).message);
      expect(messages).toEqual(['third', 'second']);
    } finally {
      await sys.terminate();
    }
  });

  test('retention ages letters out', async () => {
    const sys = newSystem('dlq-retention', { store: 'memory', retention: '1ms' });
    try {
      await deadLetterTo(sys, 'gone', 'lost');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 0, {
        timeoutMs: 4_000,
        label: 'the letter aged out',
      });
    } finally {
      await sys.terminate();
    }
  });

  test('list narrows by recipient subtree and by time', async () => {
    const sys = newSystem('dlq-filter', { store: 'memory' });
    try {
      await deadLetterTo(sys, 'alpha', 'a');
      await deadLetterTo(sys, 'beta', 'b');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 2, {
        timeoutMs: 4_000,
        label: 'both letters reached the queue',
      });

      const exact = await sys.deadLetterQueue.list({
        recipient: `actor-ts://${sys.name}/user/alpha`,
      });
      expect(exact.map((e) => (e.payload as { message: unknown }).message)).toEqual(['a']);

      const subtree = await sys.deadLetterQueue.list({
        recipient: `actor-ts://${sys.name}/user`,
      });
      expect(subtree.length).toBe(2);

      expect(await sys.deadLetterQueue.list({ untilMs: 0 })).toEqual([]);
      expect((await sys.deadLetterQueue.list({ limit: 1 })).length).toBe(1);
    } finally {
      await sys.terminate();
    }
  });

  test('clear empties the queue', async () => {
    const sys = newSystem('dlq-clear', { store: 'memory' });
    try {
      await deadLetterTo(sys, 'gone', 'lost');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      await sys.deadLetterQueue.clear();
      expect(await sys.deadLetterQueue.list()).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_dead_letters_total ticks with the recipient as a label', async () => {
    const sys = newSystem('dlq-metric', { store: 'memory' });
    const registry = sys.extension(MetricsExtensionId).enable();
    try {
      await deadLetterTo(sys, 'gone', 'lost');
      await awaitCondition(
        () => registry.collect().some((s) => s.name === 'actor_dead_letters_total'),
        { timeoutMs: 4_000, label: 'the counter was minted' },
      );
      const sample = registry.collect().find((s) => s.name === 'actor_dead_letters_total')!;
      expect(sample.labels.outcome).toBe('captured');
      expect(String(sample.labels.recipient)).toContain('/user/gone');
    } finally {
      await sys.terminate();
    }
  });
});

describe('DeadLetterQueue — replay', () => {
  test('redelivers to a respawned actor at the original path and removes the entry', async () => {
    const sys = newSystem('dlq-replay', { store: 'memory' });
    try {
      const received: string[] = [];
      class Recorder extends Actor<string> {
        override onReceive(m: string): void { received.push(m); }
      }

      await deadLetterTo(sys, 'worker', 'work');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();

      // Replay is a fresh path lookup on purpose: the point is that the
      // recipient has come back since, at the same address but as a new
      // instance, which a ref captured at failure time could never reach.
      sys.spawn(Recorder, 'worker');
      const result = await sys.deadLetterQueue.replay(entry!.id);

      expect(result.kind).toBe('replayed');
      await awaitCondition(() => received.includes('work'), {
        timeoutMs: 4_000,
        label: 'the replayed message was delivered',
      });
      expect(await sys.deadLetterQueue.list()).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('an unresolvable recipient leaves the letter in the queue', async () => {
    const sys = newSystem('dlq-replay-gone', { store: 'memory' });
    try {
      await deadLetterTo(sys, 'worker', 'work');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();
      const result = await sys.deadLetterQueue.replay(entry!.id);
      expect(result.kind).toBe('unresolved-recipient');
      expect((await sys.deadLetterQueue.list()).length).toBe(1);
    } finally {
      await sys.terminate();
    }
  });

  test('an unknown id is reported, not thrown', async () => {
    const sys = newSystem('dlq-replay-unknown', { store: 'memory' });
    try {
      expect((await sys.deadLetterQueue.replay('nope')).kind).toBe('unknown-entry');
    } finally {
      await sys.terminate();
    }
  });

  test('an alternate recipient receives the letter, and the original does not', async () => {
    // The Scope bullet #433 asks for in as many words: "replay to the
    // original OR an alternate recipient".  The original is deliberately
    // alive here so the assertion is that the letter went somewhere ELSE,
    // not merely that it went somewhere.
    const sys = newSystem('dlq-replay-alternate', { store: 'memory' });
    try {
      const original: string[] = [];
      const alternate: string[] = [];
      class Original extends Actor<string> {
        override onReceive(m: string): void { original.push(m); }
      }
      class Alternate extends Actor<string> {
        override onReceive(m: string): void { alternate.push(m); }
      }

      await deadLetterTo(sys, 'worker', 'work');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();

      sys.spawn(Original, 'worker');
      sys.spawn(Alternate, 'standby');
      const alternatePath = `actor-ts://${sys.name}/user/standby`;
      const result = await sys.deadLetterQueue.replay(entry!.id, alternatePath);

      // The result names where the letter actually went — not the entry's
      // own recipientPath, which would name the actor that got nothing.
      expect(result).toEqual({ kind: 'replayed', recipientPath: alternatePath });
      await awaitCondition(() => alternate.includes('work'), {
        timeoutMs: 4_000,
        label: 'the alternate recipient received the redirected letter',
      });
      expect(original).toEqual([]);
      expect(await sys.deadLetterQueue.list()).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('an alternate is redelivered even though the recorded path is gone', async () => {
    // The case a redirect is actually FOR: the original address is gone for
    // good — a renamed actor, a shard that moved — so resolving it as a
    // precondition would refuse exactly the letters worth redirecting.
    const sys = newSystem('dlq-replay-alternate-gone', { store: 'memory' });
    try {
      const alternate: string[] = [];
      class Alternate extends Actor<string> {
        override onReceive(m: string): void { alternate.push(m); }
      }

      await deadLetterTo(sys, 'worker', 'work');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();

      // '/user/worker' is never respawned — only the standby exists.
      sys.spawn(Alternate, 'standby');
      const result = await sys.deadLetterQueue
        .replay(entry!.id, `actor-ts://${sys.name}/user/standby`);

      expect(result.kind).toBe('replayed');
      await awaitCondition(() => alternate.includes('work'), {
        timeoutMs: 4_000,
        label: 'the redirected letter arrived although its recorded path is dead',
      });
    } finally {
      await sys.terminate();
    }
  });

  test('an alternate that resolves to nothing names the alternate and keeps the letter', async () => {
    const sys = newSystem('dlq-replay-alternate-unresolved', { store: 'memory' });
    try {
      await deadLetterTo(sys, 'worker', 'work');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();

      // The recorded recipient IS resolvable, so a refusal here can only
      // come from the alternate — which is the point being pinned.
      sys.spawn(Nothing, 'worker');
      const nowhere = `actor-ts://${sys.name}/user/nowhere`;
      const result = await sys.deadLetterQueue.replay(entry!.id, nowhere);

      expect(result).toEqual({ kind: 'unresolved-recipient', recipientPath: nowhere });
      expect((await sys.deadLetterQueue.list()).length).toBe(1);
      expect((await sys.deadLetterQueue.list())[0]!.replayCount).toBe(0);
    } finally {
      await sys.terminate();
    }
  });

  test('a quarantined letter stays refused when an alternate is named', async () => {
    // Closes the loop the cap exists for.  If a different path granted a
    // fresh replay budget, an operator (or a script) could alternate between
    // two addresses forever — the unbounded retry maxReplays is there to
    // stop, reachable again through the redirect.
    //
    // Note for anyone reverting the redirect to see this fail: it will not.
    // Before `replay` grew a second parameter the extra argument was simply
    // ignored, so the refusal was already unconditional — the invariant is
    // behaviour-identical either side of that change.  This guards the
    // *decision* against a future "an alternate deserves a fresh chance"
    // patch, not the code that introduced the parameter; the four tests
    // around it are the ones bound to that.
    const sys = newSystem('dlq-replay-alternate-quarantined', {
      store: 'memory',
      'max-replays': 0,
    });
    try {
      class Alternate extends Actor<string> {
        override onReceive(_m: string): void {}
      }
      await deadLetterTo(sys, 'worker', 'work');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();
      sys.spawn(Alternate, 'standby');

      const refused = await sys.deadLetterQueue
        .replay(entry!.id, `actor-ts://${sys.name}/user/standby`);
      expect(refused).toEqual({ kind: 'quarantined', replayCount: 0 });
      expect((await sys.deadLetterQueue.list()).length).toBe(1);
    } finally {
      await sys.terminate();
    }
  });

  test('a bounce at the alternate returns as the same entry, recording the alternate', async () => {
    // Where the letter failed THIS time is what the next person reading the
    // queue needs; the identity has to stay put so the replay count keeps
    // counting the letter rather than the address.
    const sys = newSystem('dlq-replay-alternate-bounce', { store: 'memory' });
    try {
      class Refuser extends Actor<string> {
        override onReceive(m: string): void {
          this.system.deadLetters.tell(new DeadLetter(m, null, this.self));
        }
      }
      await deadLetterTo(sys, 'worker', 'work');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the letter reached the queue',
      });
      const [entry] = await sys.deadLetterQueue.list();

      sys.spawn(Refuser, 'standby');
      const standbyPath = `actor-ts://${sys.name}/user/standby`;
      expect((await sys.deadLetterQueue.replay(entry!.id, standbyPath)).kind).toBe('replayed');

      await awaitCondition(async () => {
        const [bounced] = await sys.deadLetterQueue.list();
        return bounced !== undefined && bounced.replayCount === 1;
      }, { timeoutMs: 4_000, label: 'the letter bounced back from the alternate' });

      const entries = await sys.deadLetterQueue.list();
      expect(entries.length).toBe(1);
      expect(entries[0]!.id).toBe(entry!.id);
      expect(entries[0]!.recipientPath).toBe(standbyPath);
    } finally {
      await sys.terminate();
    }
  });

  test('a poison message comes back as the SAME entry and is then quarantined', async () => {
    // The re-poisoning guard.  An actor that cannot process this particular
    // message bounces it back on every attempt; without the bookkeeping each
    // replay would mint a FRESH entry, so the queue would grow on exactly
    // the letters it should be refusing and every retry would still look
    // like a first one.
    const sys = newSystem('dlq-poison', { store: 'memory', 'max-replays': 2 });
    try {
      class Refuser extends Actor<string> {
        override onReceive(m: string): void {
          this.system.deadLetters.tell(new DeadLetter(m, null, this.self));
        }
      }
      sys.spawn(Refuser, 'worker');
      sys.actorSelection('/user/worker').tell('poison');

      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the poison message reached the queue',
      });
      const original = (await sys.deadLetterQueue.list())[0]!;
      expect(original.replayCount).toBe(0);

      for (let expected = 1; expected <= 2; expected++) {
        expect((await sys.deadLetterQueue.replay(original.id)).kind).toBe('replayed');
        await awaitCondition(async () => {
          const [entry] = await sys.deadLetterQueue.list();
          return entry !== undefined && entry.replayCount === expected;
        }, { timeoutMs: 4_000, label: `the bounce came back as replay ${expected}` });
        const [entry] = await sys.deadLetterQueue.list();
        // One entry, same identity — the assertion the whole guard exists for.
        expect((await sys.deadLetterQueue.list()).length).toBe(1);
        expect(entry!.id).toBe(original.id);
      }

      const refused = await sys.deadLetterQueue.replay(original.id);
      expect(refused).toEqual({ kind: 'quarantined', replayCount: 2 });
      expect((await sys.deadLetterQueue.list()).length).toBe(1);
    } finally {
      await sys.terminate();
    }
  });
});
