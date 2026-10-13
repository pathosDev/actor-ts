/**
 * What a terminating actor is told from inside its own termination drain is
 * dead-lettered too, never lost (found while #1468).
 *
 * `finalizeTermination` dead-letters the user messages still queued, and each
 * dead letter is published on that stack, where a callback subscriber
 * (`eventStream.subscribeFunction`) runs.  A message such a callback tells the
 * dying actor arrives while the cell is still terminating, so it is queued:
 * after the drain that would have dead-lettered it, and before the state flip
 * from which on a tell dead-letters at once.  It used to be neither handled
 * nor dead-lettered, which is the one outcome dead letters exist to rule out.
 */
import { afterEach, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type NoteMessage = { readonly kind: 'note'; readonly label: string };

const note = (label: string): NoteMessage => ({ kind: 'note', label });

/** Records the label of everything it is handed. */
class Recipient extends Actor<NoteMessage> {
  constructor(private readonly handled: string[]) { super(); }

  override onReceive(message: NoteMessage): void {
    this.handled.push(message.label);
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function newSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

test('a message a dead-letter callback tells the actor during its termination drain is dead-lettered', async () => {
  const system = newSystem('termination-drain-dead-letters');
  const handled: string[] = [];
  const ref = system.spawn(() => new Recipient(handled), 'recipient') as LocalActorRef<NoteMessage>;
  ref.tell(note('started'));
  await awaitCondition(() => handled.includes('started'), {
    timeoutMs: 4_000,
    label: 'the recipient handled its first message',
  });

  const queued = note('queued');
  const late = note('late');
  const later = note('later');
  const ours = new Set<unknown>([queued, late, later]);
  const lettered: unknown[] = [];
  let toldLate = false;
  let toldLater = false;
  const unsubscribe = system.eventStream.subscribeFunction(DeadLetter, (letter) => {
    if (ours.has(letter.message)) lettered.push(letter.message);
    // The drain's own dead letter, on the drain's own stack: tell the dying
    // actor once more from here.  And once more from the dead letter of that
    // message, so a pass that ran before the state flip would queue this one
    // in turn.
    if (!toldLate && letter.message === queued) {
      toldLate = true;
      ref.tell(late);
    }
    if (!toldLater && letter.message === late) {
      toldLater = true;
      ref.tell(later);
    }
  });
  try {
    // The stop is queued ahead of the message, so the termination drain is
    // what reaches it rather than the behavior.
    ref.stop();
    ref.tell(queued);
    await awaitCondition(() => ref.getCell().isTerminated(), {
      timeoutMs: 4_000,
      label: 'the recipient terminated',
    });
    await awaitCondition(() => lettered.includes(later), {
      timeoutMs: 2_000,
      label: 'both messages told from dead-letter callbacks reached dead letters',
    });

    expect(toldLate).toBe(true);
    expect(toldLater).toBe(true);
    expect(handled).toEqual(['started']);
    expect(lettered).toEqual([queued, late, later]);
  } finally {
    unsubscribe();
  }
});
