/**
 * `ActorCell.run()` handles a *batch* of user messages per dispatcher turn (#409).
 *
 * Before this, `run()` dequeued exactly one user message and then re-scheduled
 * from its `finally`, so every message cost a full scheduling round trip no
 * matter what any dispatcher's `throughput` was set to.  The cap was structural
 * rather than a missing loop: `schedule()` returns early while `processing` is
 * set, so a cell may only ever have ONE unit queued on a dispatcher, and
 * `processing` is cleared a microtask after the dispatcher's synchronous drain
 * loop has already found its queue empty.
 *
 * **How these tests see a turn.**  {@link CountingDispatcher} increments a
 * counter per `execute()` and the actors read it as they handle each message,
 * so messages sharing a counter value were handled in the same turn.  That is a
 * direct observation of the thing under test — a wall-clock or message-count
 * assertion would only measure it indirectly, and would still pass on the
 * one-at-a-time loop if the machine happened to be fast.
 *
 * The four break conditions each get a case, because the risk of a batch is
 * entirely in what it fails to re-check: a loop that `continue`d past a
 * throttle pause would spin the rest of its budget against a bucket that
 * cannot refill until a later tick (#1167), and one that ignored the cell
 * state would keep delivering to an actor that is stopping or suspended.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Dispatcher, DispatcherErrorSink } from '../../../src/Dispatcher.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { PoisonPill } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * An `ImmediateDispatcher` that counts the units it is handed.
 *
 * Deliberately not a wrapper around the real one: the count has to be taken
 * at `execute` time, which is the moment a cell claims its single queued
 * slot, and that is exactly what the batch is meant to make rarer.
 */
class CountingDispatcher implements Dispatcher {
  readonly id = 'counting-dispatcher';
  onError?: DispatcherErrorSink;
  turns = 0;

  execute(task: () => void | Promise<void>): void {
    this.turns += 1;
    setImmediate(() => { void task(); });
  }
}

/** Sizes of consecutive runs of equal turn numbers, in order. */
function batchSizesOf(turns: ReadonlyArray<number>): number[] {
  const sizes: number[] = [];
  let previous: number | null = null;
  for (const turn of turns) {
    if (turn === previous) sizes[sizes.length - 1] += 1;
    else { sizes.push(1); previous = turn; }
  }
  return sizes;
}

let system: ActorSystem;
let dispatcher: CountingDispatcher;

beforeEach(() => {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  system = ActorSystem.create('batching-test', systemOptions);
  dispatcher = new CountingDispatcher();
});
afterEach(async () => { await system.terminate(); });

/** Records the dispatcher turn each message was handled in. */
class TurnRecorder extends Actor<string> {
  constructor(
    private readonly turns: number[],
    private readonly readTurn: () => number,
  ) { super(); }

  override onReceive(): void { this.turns.push(this.readTurn()); }
}

describe('a dispatcher turn handles a batch of user messages', () => {
  test('several messages share one turn, and the budget bounds the batch', async () => {
    const turns: number[] = [];
    const options = ActorOptions.create<string>()
      .withDispatcher(dispatcher)
      .withThroughput(4);
    const ref = system.spawn(() => new TurnRecorder(turns, () => dispatcher.turns), 'recorder', options);

    // `tell` is synchronous and the dispatcher only runs on the next
    // macrotask, so all ten are queued before the first turn starts.
    for (let index = 0; index < 10; index++) ref.tell(`m${index}`);
    await awaitCondition(() => turns.length === 10);

    // 4 + 4 + 2 — the budget is a ceiling, and the last turn stops early
    // because the mailbox ran dry rather than because it hit the budget.
    expect(batchSizesOf(turns)).toEqual([4, 4, 2]);
  });

  test('a throughput of 1 reproduces the pre-#409 message-at-a-time loop', async () => {
    const turns: number[] = [];
    const options = ActorOptions.create<string>()
      .withDispatcher(dispatcher)
      .withThroughput(1);
    const ref = system.spawn(() => new TurnRecorder(turns, () => dispatcher.turns), 'recorder', options);

    for (let index = 0; index < 6; index++) ref.tell(`m${index}`);
    await awaitCondition(() => turns.length === 6);

    expect(batchSizesOf(turns)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test('the system-wide default applies when the actor sets no budget', async () => {
    const turns: number[] = [];
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { actor: { throughput: 3 } } });
    const configured = ActorSystem.create('batching-hocon', systemOptions);
    try {
      const options = ActorOptions.create<string>().withDispatcher(dispatcher);
      const ref = configured.spawn(
        () => new TurnRecorder(turns, () => dispatcher.turns), 'recorder', options,
      );

      for (let index = 0; index < 6; index++) ref.tell(`m${index}`);
      await awaitCondition(() => turns.length === 6);

      expect(batchSizesOf(turns)).toEqual([3, 3]);
    } finally {
      await configured.terminate();
    }
  });
});

describe('a batch ends early rather than skipping the condition that ended it', () => {
  test('a stop handled mid-batch delivers nothing behind it', async () => {
    const seen: string[] = [];
    class Recorder extends Actor<unknown> {
      override onReceive(message: unknown): void { seen.push(String(message)); }
    }
    const options = ActorOptions.create<unknown>()
      .withDispatcher(dispatcher)
      .withThroughput(16);
    const ref = system.spawn(Recorder, 'stopping', options);

    // All eight sit in the mailbox before the first turn, and the budget is
    // wide enough to swallow every one of them — so if the loop did not
    // re-check the cell state the four behind the pill would be delivered to
    // an actor that has already terminated.
    ref.tell('a');
    ref.tell('b');
    ref.tell(PoisonPill.instance);
    ref.tell('c');
    ref.tell('d');
    await awaitCondition(() => seen.length >= 2);
    await Bun.sleep(30);

    expect(seen).toEqual(['a', 'b']);
  });

  test('a throttle bucket that empties mid-batch parks the rest instead of spinning', async () => {
    type TickMessage = { kind: 'tick' };
    type ConfigureMessage = { kind: 'configure' };
    type Message = TickMessage | ConfigureMessage;

    const turns: number[] = [];
    class Throttled extends Actor<Message> {
      override onReceive(m: Message): void {
        match(m)
          .with({ kind: 'tick' }, () => this.onTick())
          .with({ kind: 'configure' }, () => this.onConfigure())
          .exhaustive();
      }

      private onTick(): void { turns.push(dispatcher.turns); }

      /** Two tokens, then a refill slow enough to be visible from the test. */
      private onConfigure(): void { this.context.throttle({ qps: 20, burst: 2 }); }
    }

    const options = ActorOptions.create<Message>()
      .withDispatcher(dispatcher)
      .withThroughput(16);
    const ref = system.spawn(Throttled, 'throttled', options);

    ref.tell({ kind: 'configure' });
    await awaitCondition(() => dispatcher.turns > 0);
    for (let index = 0; index < 6; index++) ref.tell({ kind: 'tick' });

    await awaitCondition(() => turns.length === 2);
    const turnsWhenBucketEmptied = dispatcher.turns;
    // The parked message must not earn a turn until the resume timer clears
    // it: a batch that looped instead of breaking would burn the remaining 14
    // iterations re-dequeuing the very envelope it just put back.
    await Bun.sleep(20);
    expect(turns.length).toBe(2);
    expect(batchSizesOf(turns)).toEqual([2]);

    // ...and the refill does eventually deliver the rest, on later turns.
    await awaitCondition(() => turns.length === 6, { timeoutMs: 4_000 });
    expect(dispatcher.turns).toBeGreaterThan(turnsWhenBucketEmptied);
  }, 10_000);

  test('a handler that throws ends the batch at the failure', async () => {
    const turns: number[] = [];
    class Failing extends Actor<string> {
      override onReceive(message: string): void {
        turns.push(dispatcher.turns);
        if (message === 'boom') throw new Error('boom');
      }
    }
    const options = ActorOptions.create<string>()
      .withDispatcher(dispatcher)
      .withThroughput(16);
    const ref = system.spawn(Failing, 'failing', options);

    ref.tell('a');
    ref.tell('boom');
    ref.tell('c');
    ref.tell('d');
    await awaitCondition(() => turns.length === 4);

    // `failToParent` flips the cell running -> suspended from inside the
    // handler, so the two behind the failure belong to a later turn — after
    // the supervisor has decided.  Continuing would have delivered them to a
    // suspended actor.
    const sizes = batchSizesOf(turns);
    expect(sizes[0]).toBe(2);
    expect(sizes.length).toBeGreaterThan(1);
  });
});
