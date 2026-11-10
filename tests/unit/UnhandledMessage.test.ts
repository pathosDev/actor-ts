/**
 * `Actor.unhandled` — the one place a declined message becomes observable
 * (#1178).
 *
 * The framework had half of this already: a typed behavior answering
 * `Behaviors.unhandled` was wrapped into a `DeadLetter` naming the actor.  The
 * untyped `Actor` had nothing, so every `.otherwise((m) => this.onUnhandled(m))`
 * arm — in user code and in three of the framework's own actors — ended in a
 * `return`, and a message declined by a live actor was indistinguishable from
 * one that was never sent.
 *
 * Two properties are worth stating as tests rather than as prose.
 *
 * **The counter is not redundant with the dead letter.**
 * `actor_dead_letters_total` only moves inside `DeadLetterQueue._capture`,
 * which returns immediately while `actor-ts.dead-letters.store` is `off` — the
 * shipped default.  So on a system nobody configured, routing to dead letters
 * ticks nothing, and `actor_unhandled_total` is the only rate signal present.
 * These cases leave the store at its default deliberately.
 *
 * **Nothing is detected automatically.**  The runtime cannot tell an
 * intentionally ignored message from a dropped one, so an actor that simply
 * returns still produces nothing at all.  `Ignorer` is `Decliner` with the one
 * call removed, and it is asserted silent.
 */
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { MetricsExtensionId } from '../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../src/metrics/Metrics.js';
import { DeadLetter } from '../../src/SystemMessages.js';
import { ReceptionistId } from '../../src/discovery/index.js';
import { TestKit } from '../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import { RecordingLogger } from '../util/RecordingLogger.js';

type KnownCommand = { readonly kind: 'known' };
type StrangeCommand = { readonly kind: 'strange' };
type Command = KnownCommand | StrangeCommand;

/** Says so when it declines a message. */
class Decliner extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'known' }, (m) => this.onKnown(m))
      .otherwise((m) => this.onUnhandled(m));
  }

  private onKnown(_message: KnownCommand): void { /* handled */ }
  private onUnhandled(message: Command): void { this.unhandled(message); }
}

/** The same actor with the one call removed — the "no auto-detection" control. */
class Ignorer extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'known' }, (m) => this.onKnown(m))
      .otherwise((m) => this.onUnhandled(m));
  }

  private onKnown(_message: KnownCommand): void { /* handled */ }
  private onUnhandled(_message: Command): void { /* deliberately silent */ }
}

/** Something with an identity to name as the sender. */
class Bystander extends Actor<string> {
  override onReceive(_message: string): void { /* never told anything */ }
}

const quietKit = (name: string): TestKit => TestKit.create(name, TestKitOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off));

/** Total across every series of `name` carrying `class = className`. */
function countFor(registry: MetricsRegistry, name: string, className: string): number {
  return registry.collect()
    .filter((sample) => sample.name === name && sample.labels['class'] === className)
    .reduce((total, sample) => total + sample.value, 0);
}

describe('Actor.unhandled (#1178)', () => {
  test('a declined message becomes a dead letter naming the actor and the sender', async () => {
    const kit = quietKit('unhandled-letter');
    const probe = kit.createTestProbe();
    kit.system.eventStream.subscribe(probe, DeadLetter);

    const bystander = kit.system.spawn(Bystander, 'bystander');
    const decliner = kit.system.spawn(Decliner, 'decliner');
    decliner.tell({ kind: 'known' });
    decliner.tell({ kind: 'strange' }, bystander);

    const letter = await probe.receiveOne(1_000) as DeadLetter;
    expect(letter).toBeInstanceOf(DeadLetter);
    expect(letter.message).toEqual({ kind: 'strange' });
    // `self`, not the dead-letter office: "something, somewhere, declined
    // this" is not a diagnosis, and naming the ref that did is the whole
    // reason the letter is wrapped here rather than in `DeadLetterRef`.
    expect(letter.recipient.path.toString()).toBe(decliner.path.toString());
    expect(letter.sender?.path.toString()).toBe(bystander.path.toString());
    // And only the declined one — the handled message produced nothing.
    await probe.expectNoMessage(200);

    await kit.system.terminate();
  });

  test('an actor that simply ignores a message produces nothing', async () => {
    const kit = quietKit('unhandled-silent');
    const probe = kit.createTestProbe();
    kit.system.eventStream.subscribe(probe, DeadLetter);

    const ignorer = kit.system.spawn(Ignorer, 'ignorer');
    ignorer.tell({ kind: 'strange' });

    await probe.expectNoMessage(300);
    await kit.system.terminate();
  });

  test('actor_unhandled_total carries the class and ticks per declined message', async () => {
    const kit = quietKit('unhandled-metric');
    const registry = kit.system.extension(MetricsExtensionId).enable();
    try {
      const decliner = kit.system.spawn(Decliner, 'decliner');
      const ignorer = kit.system.spawn(Ignorer, 'ignorer');
      decliner.tell({ kind: 'strange' });
      decliner.tell({ kind: 'strange' });
      decliner.tell({ kind: 'known' });
      ignorer.tell({ kind: 'strange' });

      await awaitCondition(() => countFor(registry, 'actor_unhandled_total', 'Decliner') === 2, {
        timeoutMs: 4_000,
        label: 'both declined messages were counted',
      });
      // The silent actor mints no series of its own, so the label really says
      // who declined rather than who was sent something.
      expect(countFor(registry, 'actor_unhandled_total', 'Ignorer')).toBe(0);

      // The point of having a counter at all: the dead-letter store is `off`
      // by default, so the family that would otherwise stand in for this one
      // has not even been created.
      const names = new Set(registry.collect().map((sample) => sample.name));
      expect(names.has('actor_unhandled_total')).toBe(true);
      expect(names.has('actor_dead_letters_total')).toBe(false);
    } finally {
      await kit.system.terminate();
    }
  });
});

describe('framework handlers that used to drop in silence (#1178)', () => {
  test('the receptionist keeps its warn and now dead-letters the message too', async () => {
    // #713 stopped an unrecognised remote body from failing the receptionist
    // through `.exhaustive()` and left a warn in its place.  A warn is a line
    // in a file; this is the half a monitor can see.
    const log = new RecordingLogger();
    const kit = TestKit.create('unhandled-receptionist', TestKitOptions.create().withLogger(log));
    const registry = kit.system.extension(MetricsExtensionId).enable();
    try {
      const probe = kit.createTestProbe();
      kit.system.eventStream.subscribe(probe, DeadLetter);

      const receptionist = kit.system.extension(ReceptionistId).start(null);
      // What a peer speaking a protocol this node does not know looks like: a
      // plain object with no class identity, matching no `instanceof` arm.
      receptionist.tell({ kind: 'receptionist.FromTheFuture' } as never);

      const letter = await probe.receiveOne(1_000) as DeadLetter;
      expect(letter.message).toEqual({ kind: 'receptionist.FromTheFuture' });
      expect(letter.recipient.path.toString()).toBe(receptionist.path.toString());
      expect(log.records.some((record) =>
        record.level === 'warn' && record.message.includes('receptionist: dropping'))).toBe(true);
      expect(countFor(registry, 'actor_unhandled_total', 'Receptionist')).toBe(1);
    } finally {
      await kit.system.terminate();
    }
  });
});
