import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import type { Journal } from '../../../../src/persistence/Journal.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/**
 * The acceptance criterion #433 leads with: **captured letters survive a
 * restart**.  A restart is modelled the only way it can be in-process — two
 * `ActorSystem`s with the same name, one after the other, over one journal —
 * which is exactly what a redeploy looks like from the store's side.
 *
 * The system name matters and is not incidental: the durable stream is
 * derived from it, so a queue only rejoins its own letters.
 */
const SYSTEM_NAME = 'dlq-restart';

function newSystem(journal: Journal, deadLetters: ConfigObject): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withPersistence({ journal })
    .withConfig({ 'actor-ts': { 'dead-letters': { store: 'persistent', ...deadLetters } } });
  return ActorSystem.create(SYSTEM_NAME, sysOptions);
}

class Nothing extends Actor<unknown> { override onReceive(_m: unknown): void {} }

/** Produce one genuine dead letter addressed to `/user/<name>`. */
async function deadLetterTo(system: ActorSystem, name: string, message: unknown): Promise<void> {
  const ref = system.spawn(Nothing, name);
  ref.stop();
  await awaitCondition(() => system._resolvePath(['user', name]).isNone(), {
    timeoutMs: 4_000,
    label: `the actor '${name}' reached the terminated state`,
  });
  ref.tell(message);
}

describe('DeadLetterQueue — persistent store across a restart', () => {
  test('a letter captured before shutdown is there after it', async () => {
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', { kind: 'order', id: 7 });
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    // terminate() settles the durable writes on its way out — that is the
    // half of "survives restart" the queue owns.
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      const entries = await second.deadLetterQueue.list();
      expect(entries.length).toBe(1);
      expect(entries[0]!.recipientPath).toBe(`actor-ts://${SYSTEM_NAME}/user/worker`);
      expect(entries[0]!.payload).toEqual({
        kind: 'captured',
        message: { kind: 'order', id: 7 },
      });
    } finally {
      await second.terminate();
    }
  });

  test('a replayed letter does not come back on the next start', async () => {
    // The tombstone half of the log.  Eviction is a prefix trim, but a
    // replay punches a hole above the oldest surviving entry, and without a
    // record of it the restore would resurrect a letter that was already
    // handed back — a duplicate delivery on every restart.
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', 'work');
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    const [entry] = await first.deadLetterQueue.list();
    first.spawn(Nothing, 'worker');
    expect((await first.deadLetterQueue.replay(entry!.id)).kind).toBe('replayed');
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      expect(await second.deadLetterQueue.list()).toEqual([]);
    } finally {
      await second.terminate();
    }
  });

  test('an unserialisable payload is kept as provenance and refuses replay', async () => {
    // The degraded branch.  The tagged-JSON encoder refuses a function
    // rather than degrading it silently, so a queue that must not lose the
    // letter has to give up the payload instead — and then say so, rather
    // than redelivering a placeholder.
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', { kind: 'callback', run: () => 1 });
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    // In memory it is still whole — only the durable copy gives it up.
    expect((await first.deadLetterQueue.list())[0]!.payload.kind).toBe('captured');
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      const [entry] = await second.deadLetterQueue.list();
      expect(entry!.payload.kind).toBe('degraded');
      expect(entry!.recipientPath).toBe(`actor-ts://${SYSTEM_NAME}/user/worker`);
      expect((await second.deadLetterQueue.replay(entry!.id)).kind).toBe('degraded-payload');
    } finally {
      await second.terminate();
    }
  });

  test('a queue with a different system name does not adopt the letters', async () => {
    const journal = new InMemoryJournal();
    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', 'work');
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    await first.terminate();

    const otherOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withPersistence({ journal })
      .withConfig({ 'actor-ts': { 'dead-letters': { store: 'persistent' } } });
    const other = ActorSystem.create('someone-else', otherOptions);
    try {
      expect(await other.deadLetterQueue.list()).toEqual([]);
    } finally {
      await other.terminate();
    }
  });
});
