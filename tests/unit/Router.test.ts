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
