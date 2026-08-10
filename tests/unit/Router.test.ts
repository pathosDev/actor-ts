import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorStopped, AskTimeoutError, DeadLetter } from '../../src/SystemMessages.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger, type Logger } from '../../src/Logger.js';
import { MetricsExtensionId } from '../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../src/metrics/Metrics.js';
import type { ActorFactory } from '../../src/Actor.js';
import {
  Broadcast,
  broadcastStrategy,
  randomStrategy,
  Router,
  roundRobinStrategy,
  type RoutingStrategy,
  smallestMailboxStrategy,
} from '../../src/Router.js';
import { ScatterGatherOptions } from '../../src/ScatterGatherOptions.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { OptionsError } from '../../src/util/OptionsValidator.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
/** Total deliveries recorded by the counting/registering routees. */
const totalHits = (hits: Map<string, number>): number =>
  Array.from(hits.values()).reduce((sum, count) => sum + count, 0);
const newSystem = (name = 'router-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

/** Simple recording routee used across the tests. */
function countingWorker(hits: Map<string, number>) {
  return class extends Actor<string> {
    override onReceive(_: string): void {
      const name = this.self.path.name;
      hits.set(name, (hits.get(name) ?? 0) + 1);
    }
  };
}

describe('roundRobinStrategy', () => {
  test('cycles through routees deterministically', () => {
    const routees = ['a', 'b', 'c'].map(name => ({ path: { name: name } } as never));
    const strategy = roundRobinStrategy();
    const chosen = [0, 1, 2, 3, 4, 5].map(i =>
      Array.from(strategy(routees, { messageIndex: i }))[0]!,
    );
    expect((chosen.map((r: any) => r.path.name))).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  test('returns empty for empty routees', () => {
    expect(Array.from(roundRobinStrategy()([], { messageIndex: 0 }))).toEqual([]);
  });
});

describe('randomStrategy', () => {
  test('returns one routee per call from the given set', () => {
    const routees = ['a', 'b', 'c'].map(name => ({ path: { name: name } } as never));
    for (let i = 0; i < 20; i++) {
      const picked = Array.from(randomStrategy()(routees, { messageIndex: i }));
      expect(picked.length).toBe(1);
      expect(routees).toContain(picked[0]!);
    }
  });

  test('returns empty for empty routees', () => {
    expect(Array.from(randomStrategy()([], { messageIndex: 0 }))).toEqual([]);
  });
});

describe('broadcastStrategy', () => {
  test('returns every routee', () => {
    const routees = ['a', 'b', 'c'].map(name => ({ path: { name: name } } as never));
    const out = Array.from(broadcastStrategy()(routees, { messageIndex: 0 }));
    expect(out).toEqual(routees);
  });
});

/**
 * Routee that parks on a shared gate, so a test can build a mailbox backlog
 * on purpose: the first message is in flight (depth 0) and everything told
 * afterwards stays queued until the gate is released.
 */
function gatedWorker(
  handled: Map<string, string[]>,
  started: Set<string>,
  gate: Promise<void>,
) {
  return class extends Actor<string> {
    override async onReceive(message: string): Promise<void> {
      const name = this.self.path.name;
      started.add(name);
      await gate;
      const seen = handled.get(name) ?? [];
      seen.push(message);
      handled.set(name, seen);
    }
  };
}

/** A gate plus the function that opens it — every gated test must release. */
function newGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

/**
 * Records which actors have reached the `terminated` state.
 *
 * `postStop` is the wrong signal for that: the cell runs it, drains its
 * mailbox and only *then* flips the state, so an assertion hung on `postStop`
 * can read a cell that is still `stopping`.  `ActorStopped` is published after
 * the flip, which makes it the only public "it is really gone" edge.
 */
function terminationObserver(terminatedNames: Set<string>) {
  return class extends Actor<ActorStopped> {
    override preStart(): void { this.system.eventStream.subscribe(this.self, ActorStopped); }
    override onReceive(event: ActorStopped): void { terminatedNames.add(event.actor.path.name); }
  };
}

/**
 * Name of the routee a strategy picks — asserting on the name instead of the
 * ref keeps a failure diff to one word, where `toBe(ref)` dumps a whole
 * `LocalActorRef` and its system.
 */
const chosenName = (
  strategy: RoutingStrategy,
  routees: ReadonlyArray<ActorRef>,
  messageIndex: number,
): string | undefined => Array.from(strategy(routees, { messageIndex }))[0]?.path.name;

describe('smallestMailboxStrategy (#154)', () => {
  test('returns empty for empty routees', () => {
    expect(Array.from(smallestMailboxStrategy()([], { messageIndex: 0 }))).toEqual([]);
  });

  test('falls back to the rotation when no depth is readable', () => {
    // A ref that is not locally hosted has no mailbox this process can read.
    // The strategy must still route — silently dropping would be worse than
    // degrading to round-robin.
    const routees = ['a', 'b', 'c'].map(name => ({ path: { name: name } } as never));
    const strategy = smallestMailboxStrategy();
    const chosen = [0, 1, 2, 3, 4, 5].map(i =>
      Array.from(strategy(routees, { messageIndex: i }))[0]!,
    );
    expect(chosen.map((r: any) => r.path.name)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  test('picks the routee with the shortest queue', async () => {
    const handled = new Map<string, string[]>();
    const started = new Set<string>();
    const { gate, release } = newGate();
    const sys = newSystem('smallest-depth');
    const deep = sys.spawn(() => new (gatedWorker(handled, started, gate))(), 'deep');
    const shallow = sys.spawn(() => new (gatedWorker(handled, started, gate))(), 'shallow');

    // One message each parks the actor on the gate, so both mailboxes are at
    // depth 0 and everything told from here on is measurable backlog.
    deep.tell('inflight');
    shallow.tell('inflight');
    await awaitCondition(() => started.size === 2, {
      timeoutMs: 4_000,
      label: 'both actors parked on the gate',
    });
    for (let i = 0; i < 4; i++) deep.tell('backlog');
    shallow.tell('backlog');

    const pool: ReadonlyArray<ActorRef> = [deep, shallow];
    const strategy = smallestMailboxStrategy();
    // Both rotation offsets must agree: depth decides, the rotation only
    // breaks ties.  `messageIndex: 1` starts the scan on the deep routee, so
    // it also proves the scan keeps looking past its own starting point.
    expect(Array.from(strategy(pool, { messageIndex: 0 }))[0]).toBe(shallow as ActorRef);
    expect(Array.from(strategy(pool, { messageIndex: 1 }))[0]).toBe(shallow as ActorRef);

    release();
    await sys.terminate();
  });

  test('equal depths rotate instead of pinning the first routee', async () => {
    const handled = new Map<string, string[]>();
    const started = new Set<string>();
    const { gate, release } = newGate();
    const sys = newSystem('smallest-tie');
    const names = ['one', 'two', 'three'];
    const refs = names.map(name =>
      sys.spawn(() => new (gatedWorker(handled, started, gate))(), name),
    );
    for (const ref of refs) ref.tell('inflight');
    await awaitCondition(() => started.size === 3, {
      timeoutMs: 4_000,
      label: 'all three actors parked on the gate',
    });

    // Every mailbox is at 0 now.  Without the rotation tie-break a
    // "first minimum wins" scan would hand all six to `one`.
    const pool: ReadonlyArray<ActorRef> = refs;
    const strategy = smallestMailboxStrategy();
    const chosen = [0, 1, 2, 3, 4, 5].map(i =>
      Array.from(strategy(pool, { messageIndex: i }))[0]!,
    );
    expect(chosen.map(r => r.path.name)).toEqual(['one', 'two', 'three', 'one', 'two', 'three']);

    release();
    await sys.terminate();
  });

  test('never picks a terminated routee, whose depth reads 0 forever', async () => {
    const handled = new Map<string, string[]>();
    const started = new Set<string>();
    const terminatedNames = new Set<string>();
    const { gate, release } = newGate();
    const sys = newSystem('smallest-terminated');
    sys.spawn(() => new (terminationObserver(terminatedNames))(), 'termination-observer');
    const surviving = sys.spawn(() => new (gatedWorker(handled, started, gate))(), 'surviving');
    const doomed = sys.spawn(() => new (gatedWorker(handled, started, gate))(), 'doomed');

    // Park the survivor and give it a real backlog, so on every honest reading
    // it is the deeper of the two.
    surviving.tell('inflight');
    await awaitCondition(() => started.has('surviving'), {
      timeoutMs: 4_000,
      label: 'the surviving routee parked on the gate',
    });
    for (let i = 0; i < 3; i++) surviving.tell('backlog');

    doomed.stop();
    // `ActorStopped` is published *after* the cell flips to `terminated`, so
    // it is the one public signal that the precondition actually holds —
    // `postStop` runs a step earlier, while the state is still `stopping`.
    await awaitCondition(() => terminatedNames.has('doomed'), {
      timeoutMs: 4_000,
      label: 'the doomed routee reached the terminated state',
    });

    // A terminated cell dead-letters instead of enqueueing, so its mailbox
    // size is pinned at 0: read as a plain depth it is the most attractive
    // routee in the pool, permanently, and every message routed to it is lost.
    const pool: ReadonlyArray<ActorRef> = [surviving as ActorRef, doomed as ActorRef];
    const strategy = smallestMailboxStrategy();
    // Both offsets: 0 starts the scan on the live routee, 1 starts it on the
    // dead one — where the rotation begins must not decide the answer.
    expect(chosenName(strategy, pool, 0)).toBe('surviving');
    expect(chosenName(strategy, pool, 1)).toBe('surviving');

    release();
    await sys.terminate();
  });

  test('weighs a routee whose depth is unreadable as empty rather than starving it', async () => {
    const handled = new Map<string, string[]>();
    const started = new Set<string>();
    const { gate, release } = newGate();
    const sys = newSystem('smallest-mixed');
    const local = sys.spawn(() => new (gatedWorker(handled, started, gate))(), 'local');

    local.tell('inflight');
    await awaitCondition(() => started.has('local'), {
      timeoutMs: 4_000,
      label: 'the local routee parked on the gate',
    });
    for (let i = 0; i < 3; i++) local.tell('backlog');

    // A ref that is not locally hosted has no mailbox this process can read.
    // Skipping it starves it for as long as any local routee has a backlog,
    // which in a mixed pool is exactly the situation the strategy exists for.
    const unreadable = { path: { name: 'unreadable' } } as never as ActorRef;
    const pool: ReadonlyArray<ActorRef> = [local as ActorRef, unreadable];
    const strategy = smallestMailboxStrategy();
    expect(chosenName(strategy, pool, 0)).toBe('unreadable');
    expect(chosenName(strategy, pool, 1)).toBe('unreadable');

    release();
    await sys.terminate();
  });
});

describe('Router.smallestMailbox (integration, #154)', () => {
  test('routes around a routee that is already backed up', async () => {
    const handled = new Map<string, string[]>();
    const started = new Set<string>();
    const refs = new Map<string, ActorRef<string>>();
    const { gate, release } = newGate();
    const sys = newSystem('smallest-pool');

    // The pool's own routees are private, so the worker registers itself —
    // the test needs to address one directly to make it the deep one.
    const routee = class extends gatedWorker(handled, started, gate) {
      override preStart(): void {
        refs.set(this.self.path.name, this.self as unknown as ActorRef<string>);
      }
    };
    const pool = sys.spawn(Router.smallestMailbox(3, routee), 'pool');

    // Three messages over an idle pool tie on depth 0 and therefore rotate,
    // one per routee — each parks on the gate, leaving all depths at 0.
    for (let i = 0; i < 3; i++) pool.tell('warmup');
    await awaitCondition(() => started.size === 3 && refs.size === 3, {
      timeoutMs: 4_000,
      label: 'every routee parked on the gate',
    });

    // Back one routee up behind the router's back.  Nothing can drain while
    // the gate is shut, so the depths the strategy sees are exactly these.
    for (let i = 0; i < 3; i++) refs.get('routee-2')!.tell('direct');
    for (let i = 0; i < 4; i++) pool.tell('go');

    release();
    const totalHandled = (): number =>
      Array.from(handled.values()).reduce((sum, list) => sum + list.length, 0);
    await awaitCondition(() => totalHandled() === 3 + 3 + 4, {
      timeoutMs: 4_000,
      label: 'every message was handled',
    });

    // The backed-up routee is three messages deep while the other two are
    // empty, and four routed messages are not enough to level that out — so
    // it must receive none of them, and the other two must split them evenly.
    const routedTo = (name: string): number =>
      (handled.get(name) ?? []).filter(m => m === 'go').length;
    expect(handled.get('routee-2')).toEqual(['warmup', 'direct', 'direct', 'direct']);
    expect(routedTo('routee-2')).toBe(0);
    expect(routedTo('routee-1') + routedTo('routee-3')).toBe(4);
    expect(Math.abs(routedTo('routee-1') - routedTo('routee-3'))).toBeLessThanOrEqual(1);

    await sys.terminate();
  });

  test('a routee that dies mid-burst loses nothing before the prune lands', async () => {
    const handled = new Map<string, string[]>();
    const started = new Set<string>();
    const refs = new Map<string, ActorRef<string>>();
    const deadLetters: unknown[] = [];
    const { gate, release } = newGate();
    const sys = newSystem('smallest-death');
    sys.spawn(() => new (deadLetterCollector(deadLetters))(), 'dead-letters');

    const routee = class extends gatedWorker(handled, started, gate) {
      override preStart(): void {
        refs.set(this.self.path.name, this.self as unknown as ActorRef<string>);
      }
    };
    const pool = sys.spawn(Router.smallestMailbox(3, routee), 'pool');
    await awaitCondition(() => refs.size === 3, {
      timeoutMs: 4_000,
      label: 'all three routees registered themselves',
    });

    // Address the two survivors directly so the doomed one stays idle: it must
    // die with an empty mailbox, otherwise its own backlog would dead-letter
    // and blur the count this test is about.
    refs.get('routee-1')!.tell('park');
    refs.get('routee-3')!.tell('park');
    await awaitCondition(() => started.has('routee-1') && started.has('routee-3'), {
      timeoutMs: 4_000,
      label: 'both surviving routees parked on the gate',
    });
    for (let i = 0; i < 2; i++) {
      refs.get('routee-1')!.tell('backlog');
      refs.get('routee-3')!.tell('backlog');
    }

    // The ordering is the whole test.  `stop()` is enqueued first, so the
    // doomed routee's turn runs before the router's — it is already terminated
    // when the first burst message is routed, and nothing is ever handed to a
    // live-but-stopping cell.  The burst is enqueued in the same synchronous
    // block, so the `Terminated` that prunes the pool — a *user* message —
    // lands behind all of it: for the whole burst the router still holds a
    // dead ref whose mailbox reads 0.
    const burst = 200;
    refs.get('routee-2')!.stop();
    for (let i = 0; i < burst; i++) pool.tell('go');

    // Let the router drain its queue while every surviving routee is still
    // parked, so their depths stay above 0 for the whole burst.  A settle, not
    // a race: cutting it short only makes the dead routee a weaker magnet, it
    // can never turn a real loss into a pass.
    await sleep(100);
    release();

    const totalHandled = (): number =>
      Array.from(handled.values()).reduce((sum, list) => sum + list.length, 0);
    const parkAndBacklog = 2 + 4;
    await awaitCondition(() => totalHandled() + deadLetters.length >= burst + parkAndBacklog, {
      timeoutMs: 8_000,
      label: 'every burst message was delivered or dead-lettered',
    });

    // The regression this guards: the dead routee read as the shallowest
    // mailbox in the pool, so the strategy handed it the *entire* burst and
    // all 200 messages became dead letters — a routee death cost far more
    // under smallest-mailbox than under round-robin, which would have lost
    // only its 1-in-N share of the same window.
    const routedTo = (name: string): number =>
      (handled.get(name) ?? []).filter(m => m === 'go').length;
    // Counted, not compared as a list: the pre-fix failure is 200 identical
    // strings, and a count says how bad it is where a diff only says "not []".
    expect(deadLetters.filter(m => m === 'go').length).toBe(0);
    expect(routedTo('routee-1') + routedTo('routee-3')).toBe(burst);
    expect(handled.has('routee-2')).toBe(false);

    await sys.terminate();
  });
});

describe('Router.roundRobin (integration)', () => {
  test('distributes messages evenly across routees', async () => {
    const hits = new Map<string, number>();
    const sys = newSystem();
    const pool = sys.spawn(
      Router.roundRobin(3, () => new (countingWorker(hits))()),
      'pool',
    );
    for (let i = 0; i < 9; i++) pool.tell('go');
    await awaitCondition(() => totalHits(hits) === 9, {
      timeoutMs: 4_000,
      label: 'all nine messages reached a routee',
    });
    expect(hits.size).toBe(3);
    for (const hitCount of hits.values()) expect(hitCount).toBe(3);
    await sys.terminate();
  });

  test('routee names follow "routee-N" convention', async () => {
    const hits = new Map<string, number>();
    const sys = newSystem();
    const pool = sys.spawn(
      Router.roundRobin(2, () => new (countingWorker(hits))()),
      'pool',
    );
    pool.tell('x'); pool.tell('y');
    await awaitCondition(() => totalHits(hits) === 2, {
      timeoutMs: 4_000,
      label: 'both messages reached a routee',
    });
    const names = Array.from(hits.keys()).sort();
    expect(names).toEqual(['routee-1', 'routee-2']);
    await sys.terminate();
  });
});

describe('Router.random (integration)', () => {
  test('delivers total count of messages across the pool', async () => {
    const hits = new Map<string, number>();
    const sys = newSystem();
    const pool = sys.spawn(
      Router.random(4, () => new (countingWorker(hits))()),
      'pool',
    );
    const total = 30;
    for (let i = 0; i < total; i++) pool.tell('x');
    await awaitCondition(() => totalHits(hits) >= total, {
      timeoutMs: 4_000,
      label: 'every message reached a routee',
    });
    let sum = 0;
    for (const hitCount of hits.values()) sum += hitCount;
    expect(sum).toBe(total);
    await sys.terminate();
  });
});

describe('Router.broadcast (explicit Broadcast message)', () => {
  test('Broadcast delivers to every routee', async () => {
    const hits = new Map<string, number>();
    const sys = newSystem();
    const pool = sys.spawn(
      Router.roundRobin(4, () => new (countingWorker(hits))()),
      'pool',
    );
    pool.tell(new Broadcast('hello'));
    await awaitCondition(() => totalHits(hits) === 4, {
      timeoutMs: 4_000,
      label: 'the broadcast reached all four routees',
    });
    expect(hits.size).toBe(4);
    for (const hitCount of hits.values()) expect(hitCount).toBe(1);
    await sys.terminate();
  });
});

/** Routee that also records its own ref, so a test can stop one by name. */
function registeringWorker(
  hits: Map<string, number>,
  refs: Map<string, ActorRef>,
  stopped: Set<string> = new Set(),
) {
  return class extends Actor<string> {
    override preStart(): void {
      refs.set(this.self.path.name, this.self as unknown as ActorRef);
    }
    override onReceive(message: string): void {
      const name = this.self.path.name;
      hits.set(name, (hits.get(name) ?? 0) + 1);
    }
    override postStop(): void { stopped.add(this.self.path.name); }
  };
}

/** Collects every dead letter the system reports, which is where the loss shows. */
function deadLetterCollector(seen: unknown[]) {
  return class extends Actor<DeadLetter> {
    override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
    override onReceive(letter: DeadLetter): void { seen.push(letter.message); }
  };
}

describe('Router — terminated routees (#449)', () => {
  test('a stopped routee is pruned instead of keeping its share of the traffic', async () => {
    const hits = new Map<string, number>();
    const refs = new Map<string, ActorRef>();
    const stopped = new Set<string>();
    const deadLetters: unknown[] = [];
    const sys = newSystem('router-prune');
    sys.spawn(() => new (deadLetterCollector(deadLetters))(), 'dead-letters');
    const pool = sys.spawn(
      Router.roundRobin(3, () => new (registeringWorker(hits, refs, stopped))()),
      'pool',
    );

    for (let i = 0; i < 3; i++) pool.tell('warmup');
    await awaitCondition(() => refs.size === 3, {
      timeoutMs: 4_000,
      label: 'all three routees registered themselves',
    });
    expect(refs.size).toBe(3);

    refs.get('routee-2')!.stop();
    // The router's `routees` array is private, so the prune itself is not
    // observable; the routee stopping is, and the Terminated that triggers the
    // prune is sent from the same `finalizeTermination`.  The short settle
    // covers only that one hop rather than the whole stop.
    await awaitCondition(() => stopped.has('routee-2'), {
      timeoutMs: 4_000,
      label: 'the routee being removed stopped',
    });
    await sleep(30);

    hits.clear();
    deadLetters.length = 0;
    for (let i = 0; i < 6; i++) pool.tell('go');
    // Every message ends up either delivered or dead-lettered, so this waits
    // for all six to be accounted for whether or not the prune worked — the
    // assertions below then say which it was, instead of the wait timing out
    // with no diagnosis.
    await awaitCondition(() => totalHits(hits) + deadLetters.length >= 6, {
      timeoutMs: 4_000,
      label: 'all six messages were accounted for',
    });

    // The router has always watched its routees, but nothing consumed the
    // Terminated — so the dead ref stayed in the pool and kept being chosen.
    // Two of these six used to land on it: 4 arrived, 2 were dead-lettered.
    const delivered = Array.from(hits.values()).reduce((a, b) => a + b, 0);
    expect(delivered).toBe(6);
    expect(deadLetters).toEqual([]);
    expect(Array.from(hits.keys()).sort()).toEqual(['routee-1', 'routee-3']);

    await sys.terminate();
  });

  test('a broadcast no longer tells the pruned routee', async () => {
    const hits = new Map<string, number>();
    const refs = new Map<string, ActorRef>();
    const stopped = new Set<string>();
    const deadLetters: unknown[] = [];
    const sys = newSystem('router-broadcast-prune');
    sys.spawn(() => new (deadLetterCollector(deadLetters))(), 'dead-letters');
    const pool = sys.spawn(
      Router.broadcast(3, () => new (registeringWorker(hits, refs, stopped))()),
      'pool',
    );

    pool.tell('warmup');
    await awaitCondition(() => totalHits(hits) === 3, {
      timeoutMs: 4_000,
      label: 'the warm-up broadcast reached all three routees',
    });
    refs.get('routee-3')!.stop();
    // Same as above: the prune is private state, the stop is not.
    await awaitCondition(() => stopped.has('routee-3'), {
      timeoutMs: 4_000,
      label: 'the routee being removed stopped',
    });
    await sleep(30);

    hits.clear();
    deadLetters.length = 0;
    pool.tell(new Broadcast('go') as never);
    await awaitCondition(() => totalHits(hits) + deadLetters.length >= 2, {
      timeoutMs: 4_000,
      label: 'the broadcast reached the surviving routees',
    });
    await sleep(20);

    // A broadcast reaches every routee in the pool, so a stale member is one
    // guaranteed dead letter per broadcast rather than a probabilistic share.
    expect(Array.from(hits.keys()).sort()).toEqual(['routee-1', 'routee-2']);
    expect(deadLetters).toEqual([]);

    await sys.terminate();
  });
});

describe('Router — pool size (#455)', () => {
  const someRoutee = (): ActorFactory<string> => () => new (countingWorker(new Map()))();

  test('every factory rejects a size that cannot produce a working pool', () => {
    // size <= 0 used to yield an empty pool: preStart's loop never ran, every
    // strategy returned nothing, and all traffic went silently to dead letters.
    for (const size of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => Router.roundRobin(size, someRoutee())).toThrow(OptionsError);
      expect(() => Router.random(size, someRoutee())).toThrow(OptionsError);
      expect(() => Router.broadcast(size, someRoutee())).toThrow(OptionsError);
      expect(() => Router.smallestMailbox(size, someRoutee())).toThrow(OptionsError);
      expect(() => Router.custom(size, someRoutee(), roundRobinStrategy())).toThrow(OptionsError);
    }
  });

  test('the error names the field and the rejected value', () => {
    try {
      Router.roundRobin(0, someRoutee());
      throw new Error('expected Router.roundRobin to reject size 0');
    } catch (e) {
      expect(e).toBeInstanceOf(OptionsError);
      expect((e as OptionsError).field).toBe('size');
      expect((e as OptionsError).value).toBe(0);
      expect((e as OptionsError).message).toMatch(/integer >= 1/);
    }
  });

  test('a pool of one is valid', async () => {
    const hits = new Map<string, number>();
    const sys = newSystem('router-single');
    const pool = sys.spawn(
      Router.roundRobin(1, () => new (countingWorker(hits))()),
      'pool',
    );
    pool.tell('x'); pool.tell('y');
    await awaitCondition(() => hits.get('routee-1') === 2, {
      timeoutMs: 4_000,
      label: 'the single routee handled both messages',
    });
    expect(hits.get('routee-1')).toBe(2);
    await sys.terminate();
  });
});

/* ------------------- ScatterGatherFirstCompleted (#153) ------------------- */

/** What the scatter/gather routees recorded: what arrived, what they answered. */
type ReplierLog = { readonly seen: string[]; readonly replied: string[] };

const newReplierLog = (): ReplierLog => ({ seen: [], replied: [] });

/**
 * Routee that answers `delaysMs.get(name)` milliseconds after it is asked —
 * on a timer rather than with an `await`, so a slow routee never parks its
 * own mailbox and the configured delays stay independent of arrival order.
 * That matters for the parallelism test, where the router is the only thing
 * left that could serialise.
 */
function scheduledReplier(delaysMs: Map<string, number>, log: ReplierLog = newReplierLog()) {
  return class extends Actor<string> {
    override onReceive(message: string): void {
      const name = this.self.path.name;
      const reply = `${name}:${message}`;
      log.seen.push(reply);
      const replyTo = this.sender.toNullable();
      const answer = (): void => { log.replied.push(reply); replyTo?.tell(reply); };
      const delayMs = delaysMs.get(name) ?? 0;
      if (delayMs === 0) { answer(); return; }
      setTimeout(answer, delayMs);
    }
  };
}

/** Routee that never answers — drives the timeout and the shutdown paths. */
class SilentRoutee extends Actor<string> {
  override onReceive(_message: string): void { /* deliberately no reply */ }
}

/** Routee that answers with an `Error`, which rejects the router's own ask. */
function refusingRoutee(log: ReplierLog) {
  return class extends Actor<string> {
    override onReceive(message: string): void {
      const name = this.self.path.name;
      log.seen.push(`${name}:${message}`);
      this.sender.toNullable()?.tell(new Error(`${name} refused`));
    }
  };
}

/** What a probe actor saw — the payload plus who it was attributed to. */
type ProbeRecord = { readonly message: unknown; readonly sender: string };

function probeActor(records: ProbeRecord[]) {
  return class extends Actor<unknown> {
    override onReceive(message: unknown): void {
      records.push({ message, sender: this.sender.toNullable()?.path.name ?? '<none>' });
    }
  };
}

/** Captures `log.warn` so the drop path can be asserted on, not just eyeballed. */
class RecordingLogger implements Logger {
  readonly level = LogLevel.Warn;
  constructor(readonly warnings: string[]) {}
  debug(): void {}
  info(): void {}
  warn(message: string): void { this.warnings.push(message); }
  error(): void {}
  withSource(): Logger { return this; }
  withFields(): Logger { return this; }
}

/** Value of `router_scatter_gather_resolved_total` for one outcome label. */
const resolvedCount = (registry: MetricsRegistry, outcome: string): number | undefined =>
  registry.collect().find(
    (s) => s.name === 'router_scatter_gather_resolved_total' && s.labels.outcome === outcome,
  )?.value;

describe('Router.scatterGatherFirstCompleted (#153)', () => {
  test('scatters to every routee and answers with the first reply', async () => {
    const log = newReplierLog();
    const delays = new Map([['routee-1', 300], ['routee-2', 0], ['routee-3', 300]]);
    const sys = newSystem('scatter-first');
    const pool = sys.spawn(
      Router.scatterGatherFirstCompleted(3, scheduledReplier(delays, log)),
      'replicas',
    );

    // routee-2 is the only one that answers in this turn, and it is not the
    // first routee — so a pool that merely picked routee-1 would fail here.
    expect(await pool.ask<string>('q')).toBe('routee-2:q');
    // The fan-out is the point: everyone was asked, not just the winner.  This
    // has to be waited for rather than asserted straight away — the winner
    // resolves the ask as soon as it answers, which can be before the other
    // routees have had a mailbox turn at all.
    await awaitCondition(() => log.seen.length === 3, {
      timeoutMs: 4_000,
      label: 'every routee received the scattered message',
    });
    expect(log.seen.slice().sort()).toEqual(['routee-1:q', 'routee-2:q', 'routee-3:q']);

    await sys.terminate();
  });

  test('a late reply from a loser never reaches the caller a second time', async () => {
    const log = newReplierLog();
    const delays = new Map([['routee-1', 40], ['routee-2', 0]]);
    const records: ProbeRecord[] = [];
    const deadLetters: unknown[] = [];
    const sys = newSystem('scatter-losers');
    sys.spawn(() => new (deadLetterCollector(deadLetters))(), 'dead-letters');
    const probe = sys.spawn(() => new (probeActor(records))(), 'probe');
    const pool = sys.spawn(
      Router.scatterGatherFirstCompleted(2, scheduledReplier(delays, log)),
      'replicas',
    );

    // The tell-with-sender shape: no `ask`, the caller is a real actor.
    pool.tell('q', probe);
    // Wait until the LOSER has answered too — the interesting moment is after
    // its reply has landed somewhere, not after the winner's has.
    await awaitCondition(() => log.replied.length === 2, {
      timeoutMs: 4_000,
      label: 'both routees answered, winner and loser',
    });
    await sleep(20);

    // Exactly one reply, attributed to the routee that produced it — the
    // caller sees what it would have seen asking that routee directly.
    expect(records).toEqual([{ message: 'routee-2:q', sender: 'routee-2' }]);
    // The loser answered the router's own ask ref, which drops silently.  That
    // ref is not an actor, so this is NOT a dead letter — asserting the
    // absence is what keeps the docs honest about where losing replies go.
    expect(deadLetters).toEqual([]);

    await sys.terminate();
  });

  test('every routee failing rejects with an AggregateError carrying all of them', async () => {
    const log = newReplierLog();
    const sys = newSystem('scatter-all-failed');
    const pool = sys.spawn(Router.scatterGatherFirstCompleted(3, refusingRoutee(log)), 'replicas');

    let caught: unknown = null;
    try { await pool.ask<string>('q'); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect((aggregate.errors as Error[]).map((e) => e.message).sort())
      .toEqual(['routee-1 refused', 'routee-2 refused', 'routee-3 refused']);
    expect(aggregate.message).toMatch(/all 3 routees failed/);

    await sys.terminate();
  });

  test('nobody answering in time rejects with the per-routee ask timeouts', async () => {
    const sys = newSystem('scatter-timeout');
    const hedgeOptions = ScatterGatherOptions.create().withTimeoutMs(80);
    const pool = sys.spawn(
      Router.scatterGatherFirstCompleted(3, SilentRoutee, hedgeOptions),
      'replicas',
    );

    // The caller's own budget is far wider, so the router's deadline is what
    // fires — not the ask wrapped around it.
    let caught: unknown = null;
    try { await pool.ask<string>('q', 4_000); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(3);
    for (const err of aggregate.errors as unknown[]) expect(err).toBeInstanceOf(AskTimeoutError);
    expect(aggregate.message).toMatch(/none of 3 routees replied within 80ms/);

    await sys.terminate();
  });

  test('stopping the router fails the open scatter instead of running out the clock', async () => {
    const sys = newSystem('scatter-stop');
    const hedgeOptions = ScatterGatherOptions.create().withTimeoutMs(2_000);
    const pool = sys.spawn(
      Router.scatterGatherFirstCompleted(2, SilentRoutee, hedgeOptions),
      'replicas',
    );

    const startedAtMs = performance.now();
    const answer = pool.ask<string>('q', 4_000);
    // Both are user messages on one FIFO mailbox, so the scatter is already
    // registered by the time the PoisonPill is dequeued.
    pool.stop();

    let caught: unknown = null;
    try { await answer; } catch (e) { caught = e; }
    const elapsedMs = performance.now() - startedAtMs;

    expect((caught as Error).message).toMatch(/stopped while the scatter was still open/);
    // Without `postStop` settling it, this would have taken the full 2 s.
    expect(elapsedMs).toBeLessThan(1_000);

    await sys.terminate();
  });

  test('a tell with no reply target is dropped with a warning, not scattered', async () => {
    const warnings: string[] = [];
    const log = newReplierLog();
    const sysOptions = ActorSystemOptions.create().withLogger(new RecordingLogger(warnings));
    const sys = ActorSystem.create('scatter-no-reply-target', sysOptions);
    const registry = sys.extension(MetricsExtensionId).enable();
    const pool = sys.spawn(
      Router.scatterGatherFirstCompleted(2, scheduledReplier(new Map(), log)),
      'replicas',
    );

    pool.tell('q');
    await awaitCondition(() => warnings.some((w) => w.includes('no reply target')), {
      timeoutMs: 4_000,
      label: 'the router warned about the missing reply target',
    });

    // Warned, counted, and nothing fanned out — N times the work for a reply
    // nobody would receive is exactly what is being avoided.
    expect(log.seen).toEqual([]);
    expect(resolvedCount(registry, 'no-reply-target')).toBe(1);

    await sys.terminate();
  });

  test('every outcome is counted and the fan-out latency observed', async () => {
    const sys = newSystem('scatter-metrics');
    const registry = sys.extension(MetricsExtensionId).enable();

    const fast = sys.spawn(
      Router.scatterGatherFirstCompleted(1, scheduledReplier(new Map())),
      'fast',
    );
    expect(await fast.ask<string>('q')).toBe('routee-1:q');

    const hedgeOptions = ScatterGatherOptions.create().withTimeoutMs(60);
    const slow = sys.spawn(
      Router.scatterGatherFirstCompleted(1, SilentRoutee, hedgeOptions),
      'slow',
    );
    let caught: unknown = null;
    try { await slow.ask<string>('q', 4_000); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AggregateError);

    expect(resolvedCount(registry, 'first')).toBe(1);
    expect(resolvedCount(registry, 'timeout')).toBe(1);
    // One sample per scatter that actually ran, both outcomes included.
    expect(registry.histogram('router_scatter_gather_latency_seconds').count).toBe(2);

    await sys.terminate();
  });

  test('concurrent scatters overlap — the handler never awaits the fan-out', async () => {
    const delayMs = 20;
    const scatters = 500;
    const delays = new Map([['routee-1', delayMs], ['routee-2', delayMs], ['routee-3', delayMs]]);
    const sys = newSystem('scatter-parallel');
    const pool = sys.spawn(
      Router.scatterGatherFirstCompleted(3, scheduledReplier(delays)),
      'replicas',
    );

    const startedAtMs = performance.now();
    const answers = await Promise.all(
      Array.from({ length: scatters }, (_, i) => pool.ask<string>(`q${i}`, 4_000)),
    );
    const elapsedMs = performance.now() - startedAtMs;

    // Each caller got the answer to its own question, from some routee.
    expect(answers.filter((a, i) => a.endsWith(`:q${i}`))).toHaveLength(scatters);
    // An `async onReceive` awaiting the fan-out would hold the router's whole
    // mailbox for one scatter at a time: 500 x 20 ms is ten seconds, twenty
    // times this budget — and past Bun's own per-test timeout either way.
    expect(elapsedMs).toBeLessThan(2_500);

    await sys.terminate();
  });

  test('rejects a pool size that cannot scatter, and a non-positive timeout', () => {
    for (const size of [0, -1, 2.5, Number.NaN]) {
      expect(() => Router.scatterGatherFirstCompleted(size, SilentRoutee)).toThrow(OptionsError);
    }
    // The guard runs at the factory call, where the stack still points at the
    // caller — a bad timeout must not first surface inside `preStart`.
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY]) {
      const badOptions = ScatterGatherOptions.create().withTimeoutMs(timeoutMs);
      expect(() => Router.scatterGatherFirstCompleted(2, SilentRoutee, badOptions))
        .toThrow(OptionsError);
    }
    // A plain object is the same input as the builder.
    expect(() => Router.scatterGatherFirstCompleted(2, SilentRoutee, { timeoutMs: -5 }))
      .toThrow(OptionsError);
  });

  test('a pool whose routees have all stopped fails the scatter instead of hanging', async () => {
    const hits = new Map<string, number>();
    const refs = new Map<string, ActorRef>();
    const stopped = new Set<string>();
    const records: ProbeRecord[] = [];
    const sys = newSystem('scatter-empty-pool');
    const probe = sys.spawn(() => new (probeActor(records))(), 'probe');
    const pool = sys.spawn(
      Router.scatterGatherFirstCompleted(2, () => new (registeringWorker(hits, refs, stopped))()),
      'replicas',
    );

    // Warm up so both routees exist and have registered themselves, then stop
    // them — the router prunes each on the Terminated it already watches for.
    pool.tell('warmup', probe);
    await awaitCondition(() => refs.size === 2, {
      timeoutMs: 4_000,
      label: 'both routees registered themselves',
    });
    for (const ref of refs.values()) ref.stop();
    await awaitCondition(() => stopped.size === 2, {
      timeoutMs: 4_000,
      label: 'both routees stopped',
    });
    await sleep(30);

    let caught: unknown = null;
    try { await pool.ask<string>('q', 4_000); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([]);
    expect((caught as Error).message).toMatch(/no routees left to scatter to/);

    await sys.terminate();
  });
});
