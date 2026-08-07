import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { DeadLetter } from '../../src/SystemMessages.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import type { ActorFactory } from '../../src/Actor.js';
import {
  Broadcast,
  broadcastStrategy,
  randomStrategy,
  Router,
  roundRobinStrategy,
  smallestMailboxStrategy,
} from '../../src/Router.js';
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
