import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { DiagnosticsOptions } from '../../src/diagnostics/DiagnosticsOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ActorStopped, DeadLetter } from '../../src/SystemMessages.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';
import { RecordingLogger, type RecordedLog } from '../util/RecordingLogger.js';

const newSystem = (name = 'dl-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('DeadLetter routing', () => {
  test('a message sent to a terminated actor is published as DeadLetter on the event stream', async () => {
    const seen: DeadLetter[] = [];
    const stopped: ActorStopped[] = [];
    const subscribed = { value: false };
    // Subscribed to `ActorStopped` as well, because both halves of this test
    // are races the old fixed sleeps papered over: the listener has to be on
    // the stream before anything is published, and `dead` has to be genuinely
    // terminated before the tell — otherwise `too-late` is simply delivered
    // and no dead letter is ever produced.  `ActorStopped` is published after
    // the cell flips to `terminated`, so it is the exact signal.
    class Listener extends Actor<DeadLetter | ActorStopped> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        this.system.eventStream.subscribe(this.self, ActorStopped);
        subscribed.value = true;
      }
      override onReceive(m: DeadLetter | ActorStopped): void {
        if (m instanceof ActorStopped) stopped.push(m); else seen.push(m);
      }
    }
    class Nothing extends Actor<string> { override onReceive(_: string): void {} }

    const sys = newSystem();
    sys.spawn(Listener, 'lst');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed to the event stream',
    });

    const dead = sys.spawn(Nothing, 'n');
    dead.stop();
    await awaitCondition(() => stopped.some((e) => e.actor.equals(dead)), {
      timeoutMs: 4_000,
      label: 'the target actor reached the terminated state',
    });

    dead.tell('too-late');
    await awaitCondition(() => seen.some((d) => d.message === 'too-late'), {
      timeoutMs: 4_000,
      label: 'the message to the terminated actor reached dead letters',
    });

    expect(seen.length).toBeGreaterThan(0);
    const messages = seen.map(d => d.message);
    expect(messages).toContain('too-late');
    // Sender is null since we called tell without a sender.
    expect(seen.find(d => d.message === 'too-late')!.sender).toBeNull();
    await sys.terminate();
  });

  test('messages sent to Nobody are dropped without hitting dead letters', async () => {
    const seen: DeadLetter[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(m: DeadLetter): void { seen.push(m); }
    }
    const sys = newSystem();
    sys.spawn(Listener, 'lst');
    // The subscription is the precondition that keeps the assertion from
    // passing vacuously — without it "no dead letter arrived" is guaranteed
    // for the wrong reason.  The settle afterwards stays a plain sleep: the
    // property under test is that nothing happens, and there is no state to
    // poll for that.
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed to the event stream',
    });
    // Import Nobody lazily to avoid unused at top.
    const { Nobody } = await import('../../src/ActorRef.js');
    Nobody.tell('nothing');
    // An absence, so it cannot be polled: `Nobody` must swallow the message
    // rather than publish a DeadLetter.  `find(...) === undefined` is true the
    // instant the tell returns and has to still be true after a real window.
    await sleep(30);
    expect(seen.find(d => d.message === 'nothing')).toBeUndefined();
    await sys.terminate();
  });
});

describe('DeadLetter recipient attribution (#433)', () => {
  test('a typed behavior answering unhandled names itself, not the dead-letter office', async () => {
    // The raw `deadLetters.tell(message)` this replaced let `DeadLetterRef`
    // do the wrapping, and the ref can only name itself — so every unhandled
    // typed message came out addressed to `/deadLetters`, which is the one
    // recipient shared by the entire stream and therefore no information.
    const seen: DeadLetter[] = [];
    const subscribed = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(m: DeadLetter): void { seen.push(m); }
    }

    const sys = newSystem('dl-typed');
    sys.spawn(Listener, 'lst');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed to the event stream',
    });

    const { Behaviors } = await import('../../src/typed/Behaviors.js');
    const ref = sys.spawnTyped(
      Behaviors.receiveMessage<string>(() => Behaviors.unhandled),
      'picky',
    );
    ref.tell('nope');

    await awaitCondition(() => seen.some((d) => d.message === 'nope'), {
      timeoutMs: 4_000,
      label: 'the unhandled message reached dead letters',
    });
    const letter = seen.find((d) => d.message === 'nope')!;
    expect(letter.recipient.path.toString()).toBe(`actor-ts://${sys.name}/user/picky`);
    await sys.terminate();
  });
});

describe('DeadLetter delivery loop', () => {
  test('a terminated DeadLetter subscriber does not spin the dead-letter office', async () => {
    // Delivering a dead letter to a subscriber that has stopped without
    // unsubscribing routes it BACK to dead letters, which used to
    // republish it to the same dead subscriber until the stack blew.
    // The nested wrap is the loop signature and is dropped.
    const listenerStopped = { value: false };
    const targetStopped = { value: false };
    class Listener extends Actor<DeadLetter> {
      override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
      override onReceive(_: DeadLetter): void {}
      override postStop(): void { listenerStopped.value = true; }
    }
    class Nothing extends Actor<string> {
      override onReceive(_: string): void {}
      override postStop(): void { targetStopped.value = true; }
    }

    const sys = newSystem('dl-loop');
    const listener = sys.spawn(Listener, 'lst');
    const dead = sys.spawn(Nothing, 'n');
    dead.stop();
    await awaitCondition(() => targetStopped.value, {
      timeoutMs: 4_000,
      label: 'the dead-letter target stopped',
    });

    // Stop the subscriber but leave the subscription in place.
    listener.stop();
    await awaitCondition(() => listenerStopped.value, {
      timeoutMs: 4_000,
      label: 'the dead-letter subscriber stopped',
    });

    // Must return rather than recurse; the assertion is that we get here.
    expect(() => dead.tell('trigger')).not.toThrow();
    // An absence: a dead letter about a dead letter must not recurse.  The
    // window is what gives an unbounded loop time to take the system down, and
    // `isTerminated === false` is already true when the wait starts.
    await sleep(30);
    expect(sys.isTerminated).toBe(false);
    await sys.terminate();
  });
});

/** Only the dead-letter records, so unrelated startup chatter cannot inflate a count. */
const deadLetterRecords = (log: RecordingLogger): RecordedLog[] =>
  log.records.filter((r) => r.message.startsWith('dead letter to '));

/**
 * The default-on dead-letter log record (#1000).
 *
 * The throttle's arithmetic is pinned in
 * `tests/unit/diagnostics/DeadLetterLogging.test.ts`, against a hand-built
 * `DeadLetterRef` with an injected clock.  What can only be shown here is
 * that a *real* system supplies that machinery: that the record appears with
 * no configuration at all, that `_terminating` is what silences the teardown
 * burst, and that `withDiagnostics` reaches the ref the constructor built
 * twenty lines before the guardians existed.
 */
describe('dead letters are logged by default (#1000)', () => {
  class TooLate {}

  /**
   * A system with a capturing logger and **no diagnostics options at all** —
   * the defaults have to come from `reference.conf` through the constructor,
   * or the test proves only that the settings it passed itself work.
   */
  const recordingSystem = (name: string): { sys: ActorSystem; log: RecordingLogger } => {
    const log = new RecordingLogger();
    const sysOptions = ActorSystemOptions.create().withLogger(log);
    return { sys: ActorSystem.create(name, sysOptions), log };
  };

  test('a tell to a stopped actor produces exactly one record naming the path and the class', async () => {
    const stopped = { value: false };
    class Nothing extends Actor<TooLate> {
      override onReceive(_: TooLate): void {}
      override postStop(): void { stopped.value = true; }
    }

    const { sys, log } = recordingSystem('dl-log');
    const dead = sys.spawn(Nothing, 'n');
    dead.stop();
    // The tell has to land after the cell has genuinely terminated —
    // otherwise the message is simply delivered and no dead letter exists.
    await awaitCondition(() => stopped.value, {
      timeoutMs: 4_000,
      label: 'the target actor reached the terminated state',
    });

    dead.tell(new TooLate());
    await awaitCondition(() => deadLetterRecords(log).length > 0, {
      timeoutMs: 4_000,
      label: 'the dead letter was logged',
    });

    expect(deadLetterRecords(log)).toHaveLength(1);
    expect(deadLetterRecords(log)[0]!.level).toBe('info');
    expect(deadLetterRecords(log)[0]!.message).toContain('actor-ts://dl-log/user/n');
    expect(deadLetterRecords(log)[0]!.message).toContain('TooLate');
    // The payload is not in the record, only its class.
    expect(deadLetterRecords(log)[0]!.message).not.toContain('[object');
    await sys.terminate();
  });

  test('the teardown burst is silent, because the system is terminating', async () => {
    const { sys, log } = recordingSystem('dl-log-shutdown');
    // `terminate()` sets `_terminating` before its first suspension point,
    // so this tell is on the far side of the predicate with no race.
    const terminating = sys.terminate();
    sys.deadLetters.tell(new TooLate());
    await terminating;

    expect(deadLetterRecords(log)).toHaveLength(0);
  });

  test('...unless log-dead-letters-during-shutdown says otherwise', async () => {
    // The positive control for the test above: same tell, same moment, one
    // setting different.  Without it, a logger that silently never ran would
    // pass the silence assertion.
    const log = new RecordingLogger();
    const diagnosticsOptions = DiagnosticsOptions.create().withLogDeadLettersDuringShutdown(true);
    const sysOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withDiagnostics(diagnosticsOptions);
    const sys = ActorSystem.create('dl-log-shutdown-on', sysOptions);

    const terminating = sys.terminate();
    sys.deadLetters.tell(new TooLate());
    await terminating;

    expect(deadLetterRecords(log).length).toBeGreaterThan(0);
  });

  test('withDiagnostics(0) turns the record off, so the explicit layer is reachable', async () => {
    const log = new RecordingLogger();
    const diagnosticsOptions = DiagnosticsOptions.create().withLogDeadLetters(0);
    const sysOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withDiagnostics(diagnosticsOptions);
    const sys = ActorSystem.create('dl-log-off', sysOptions);

    sys.deadLetters.tell(new TooLate());
    // An absence, so it cannot be polled for: the record would already be
    // there, because `DeadLetterRef.tell` logs on the caller's stack.
    expect(deadLetterRecords(log)).toHaveLength(0);
    await sys.terminate();
  });
});
