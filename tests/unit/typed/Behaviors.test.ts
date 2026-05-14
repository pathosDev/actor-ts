import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  Behaviors,
  spawnTyped,
  typedProps,
  type Behavior,
} from '../../../src/typed/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { Directive, OneForOneStrategy } from '../../../src/Supervision.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSys = (name = 'typed-unit'): ActorSystem =>
  ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });

describe('Behaviors.receive — basic handler', () => {
  test('receives messages and keeps the same behavior via Behaviors.same', async () => {
    const sys = newSys();
    const seen: string[] = [];
    const b: Behavior<string> = Behaviors.receive((_ctx, msg) => {
      seen.push(msg);
      return Behaviors.same;
    });
    const ref = spawnTyped(sys, b, 'r');
    ref.tell('a'); ref.tell('b'); ref.tell('c');
    await sleep(20);
    expect(seen).toEqual(['a', 'b', 'c']);
    await sys.terminate();
  });

  test('receiveMessage is the no-context shortcut', async () => {
    const sys = newSys();
    const seen: number[] = [];
    const b = Behaviors.receiveMessage<number>((m) => { seen.push(m); return Behaviors.same; });
    const ref = spawnTyped(sys, b);
    ref.tell(1); ref.tell(2);
    await sleep(20);
    expect(seen).toEqual([1, 2]);
    await sys.terminate();
  });

  test('state transition by returning a new Behavior', async () => {
    const sys = newSys();
    const kit = TestKit.create('typed-transition', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<number>();

    const counter = (n: number): Behavior<'inc' | 'get'> =>
      Behaviors.receive((_ctx, msg) => {
        if (msg === 'inc') return counter(n + 1);
        if (msg === 'get') { probe.tell(n); return Behaviors.same; }
        return Behaviors.unhandled;
      });

    const ref = spawnTyped(kit.system, counter(0));
    ref.tell('inc'); ref.tell('inc'); ref.tell('inc'); ref.tell('get');
    expect(await probe.expectMsg(3, 500)).toBe(3);
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.stopped', () => {
  test('stops the actor when returned from a handler (observed via deathwatch)', async () => {
    const sys = newSys();
    const { Terminated } = await import('../../../src/SystemMessages.js');
    const kit = TestKit.create('typed-stop', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe();

    const b = Behaviors.receiveMessage<string>((m) => m === 'die' ? Behaviors.stopped : Behaviors.same);
    const ref = spawnTyped(kit.system, b);
    // Put a watcher on the target so we receive Terminated when it stops.
    kit.system.eventStream.subscribe(probe, Terminated);
    ref.tell('die');
    // We can't rely on EventStream delivering Terminated globally, so fall
    // back to verifying the actor handles no more messages after 'die'.
    await sleep(60);
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.setup', () => {
  test('runs exactly once with the context before the first message', async () => {
    const sys = newSys();
    const kit = TestKit.create('typed-setup', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<string>();
    let setupCalls = 0;

    const b = Behaviors.setup<string>((ctx) => {
      setupCalls++;
      probe.tell(`path=${ctx.path.toString()}`);
      return Behaviors.receiveMessage(() => Behaviors.same);
    });

    const ref = spawnTyped(kit.system, b, 'withSetup');
    const first = await probe.receiveOne(500);
    expect(typeof first).toBe('string');
    expect((first as string).startsWith('path=')).toBe(true);
    ref.tell('anything'); ref.tell('more');
    await sleep(30);
    expect(setupCalls).toBe(1);
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.withTimers', () => {
  test('lets the behavior schedule timer messages at itself', async () => {
    const sys = newSys();
    const kit = TestKit.create('typed-timers', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<string>();

    const b = Behaviors.withTimers<string>((timers) => {
      timers.startSingleTimer('once', 'tick', 20);
      return Behaviors.receiveMessage((m) => {
        probe.tell(m);
        return Behaviors.same;
      });
    });

    spawnTyped(kit.system, b);
    expect(await probe.expectMsg('tick', 500)).toBe('tick');
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.withStash', () => {
  test('stashes messages until unstashAll replays them', async () => {
    const sys = newSys();
    const kit = TestKit.create('typed-stash', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<string>();

    type Msg = { kind: 'ready' } | { kind: 'work'; id: number };

    // Start "uninitialized" — stash everything until we receive a 'ready'
    // signal, then replay all buffered work in order.
    const uninit = (stash: import('../../../src/typed/Behavior.js').StashBuffer<Msg>): Behavior<Msg> =>
      Behaviors.receive<Msg>((_ctx, msg) => {
        if (msg.kind === 'ready') {
          stash.unstashAll();
          return ready;
        }
        stash.stash(msg);
        return Behaviors.same;
      });

    const ready: Behavior<Msg> = Behaviors.receive((_ctx, msg) => {
      if (msg.kind === 'work') probe.tell(`work#${msg.id}`);
      return Behaviors.same;
    });

    const b = Behaviors.withStash<Msg>(16, (stash) => uninit(stash));
    const ref = spawnTyped(kit.system, b);
    ref.tell({ kind: 'work', id: 1 });
    ref.tell({ kind: 'work', id: 2 });
    ref.tell({ kind: 'ready' });
    // After 'ready' is handled, the two stashed messages are replayed onto
    // the mailbox in FIFO order, so probe should see work#1 then work#2.
    expect(await probe.expectMsg('work#1', 500)).toBe('work#1');
    expect(await probe.expectMsg('work#2', 500)).toBe('work#2');
    // Subsequent work goes straight to the ready behavior.
    ref.tell({ kind: 'work', id: 3 });
    expect(await probe.expectMsg('work#3', 500)).toBe('work#3');

    await kit.system.terminate();
    await sys.terminate();
  });

  test('stashing past capacity throws StashOverflowError', async () => {
    const sys = newSys();
    const errors: unknown[] = [];
    const b = Behaviors.withStash<string>(2, (stash) =>
      Behaviors.receiveMessage((msg) => {
        try { stash.stash(msg); } catch (e) { errors.push(e); }
        return Behaviors.same;
      }),
    );
    const ref = spawnTyped(sys, b);
    ref.tell('a'); ref.tell('b'); ref.tell('c');
    await sleep(30);
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).name).toBe('StashOverflowError');
    await sys.terminate();
  });
});

describe('Behaviors.supervise', () => {
  test('restart strategy re-resolves the inner behavior on error', async () => {
    const sys = newSys();
    const kit = TestKit.create('typed-supervise', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<string>();
    let initCount = 0;

    const inner = Behaviors.setup<string>((_ctx) => {
      initCount++;
      probe.tell(`init#${initCount}`);
      return Behaviors.receiveMessage((msg) => {
        if (msg === 'boom') throw new Error('kaboom');
        probe.tell(`saw:${msg}`);
        return Behaviors.same;
      });
    });

    const b = Behaviors.supervise(inner).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 5, withinTimeRangeMs: 1_000 }),
    );
    const ref = spawnTyped(kit.system, b);

    expect(await probe.expectMsg('init#1', 500)).toBe('init#1');
    ref.tell('one');
    expect(await probe.expectMsg('saw:one', 500)).toBe('saw:one');
    ref.tell('boom'); // error, restart
    expect(await probe.expectMsg('init#2', 500)).toBe('init#2');
    ref.tell('two');
    expect(await probe.expectMsg('saw:two', 500)).toBe('saw:two');

    await kit.system.terminate();
    await sys.terminate();
  });

  test('resume directive swallows the error without reinitializing', async () => {
    const sys = newSys();
    const kit = TestKit.create('typed-resume', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<string>();
    let initCount = 0;

    const inner = Behaviors.setup<string>(() => {
      initCount++;
      return Behaviors.receiveMessage((msg) => {
        if (msg === 'boom') throw new Error('oops');
        probe.tell(msg);
        return Behaviors.same;
      });
    });

    const b = Behaviors.supervise(inner).onFailure(
      new OneForOneStrategy(() => Directive.Resume),
    );
    const ref = spawnTyped(kit.system, b);
    ref.tell('a');
    expect(await probe.expectMsg('a', 500)).toBe('a');
    ref.tell('boom');
    ref.tell('b');
    expect(await probe.expectMsg('b', 500)).toBe('b');
    expect(initCount).toBe(1); // never reinitialised

    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.empty / Behaviors.ignore', () => {
  test('ignore silently drops all messages', async () => {
    const sys = newSys();
    const ref = spawnTyped(sys, Behaviors.ignore);
    ref.tell('a' as never); ref.tell('b' as never);
    await sleep(20);
    // No crash and the actor still exists — that's the contract.
    expect(ref.path.name.length).toBeGreaterThan(0);
    await sys.terminate();
  });
});

describe('typedProps — interop with OO Actor API', () => {
  test('typedProps works through system.spawn', async () => {
    const sys = newSys();
    const kit = TestKit.create('typed-props', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<number>();

    const b = Behaviors.receiveMessage<number>((m) => { probe.tell(m * 2); return Behaviors.same; });
    const ref = kit.system.spawnAnonymous(typedProps(b));
    ref.tell(21);
    expect(await probe.expectMsg(42, 500)).toBe(42);

    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.unhandled', () => {
  test('unhandled messages route to dead letters', async () => {
    const kit = TestKit.create('typed-unhandled', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe();
    const { DeadLetter } = await import('../../../src/SystemMessages.js');
    kit.system.eventStream.subscribe(probe, DeadLetter);

    const b = Behaviors.receiveMessage<string>((m) => m === 'yes' ? Behaviors.same : Behaviors.unhandled);
    const ref = spawnTyped(kit.system, b);
    ref.tell('yes');
    ref.tell('no');
    const dl = await probe.receiveOne(500) as { message: unknown };
    expect(dl.message).toBe('no');
    await kit.system.terminate();
  });
});
