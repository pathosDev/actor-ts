import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { DeadLetter } from '../../src/SystemMessages.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import {
  Broadcast,
  broadcastStrategy,
  randomStrategy,
  Router,
  roundRobinStrategy,
} from '../../src/Router.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { OptionsError } from '../../src/util/OptionsValidator.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
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
      Router.roundRobin(3, Props.create(() => new (countingWorker(hits))())),
      'pool',
    );
    for (let i = 0; i < 9; i++) pool.tell('go');
    await sleep(40);
    expect(hits.size).toBe(3);
    for (const hitCount of hits.values()) expect(hitCount).toBe(3);
    await sys.terminate();
  });

  test('routee names follow "routee-N" convention', async () => {
    const hits = new Map<string, number>();
    const sys = newSystem();
    const pool = sys.spawn(
      Router.roundRobin(2, Props.create(() => new (countingWorker(hits))())),
      'pool',
    );
    pool.tell('x'); pool.tell('y');
    await sleep(30);
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
      Router.random(4, Props.create(() => new (countingWorker(hits))())),
      'pool',
    );
    const total = 30;
    for (let i = 0; i < total; i++) pool.tell('x');
    await sleep(80);
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
      Router.roundRobin(4, Props.create(() => new (countingWorker(hits))())),
      'pool',
    );
    pool.tell(new Broadcast('hello'));
    await sleep(40);
    expect(hits.size).toBe(4);
    for (const hitCount of hits.values()) expect(hitCount).toBe(1);
    await sys.terminate();
  });
});

/** Routee that also records its own ref, so a test can stop one by name. */
function registeringWorker(hits: Map<string, number>, refs: Map<string, ActorRef>) {
  return class extends Actor<string> {
    override preStart(): void {
      refs.set(this.self.path.name, this.self as unknown as ActorRef);
    }
    override onReceive(message: string): void {
      const name = this.self.path.name;
      hits.set(name, (hits.get(name) ?? 0) + 1);
    }
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
    const deadLetters: unknown[] = [];
    const sys = newSystem('router-prune');
    sys.spawn(Props.create(() => new (deadLetterCollector(deadLetters))()), 'dead-letters');
    const pool = sys.spawn(
      Router.roundRobin(3, Props.create(() => new (registeringWorker(hits, refs))())),
      'pool',
    );

    for (let i = 0; i < 3; i++) pool.tell('warmup');
    await sleep(40);
    expect(refs.size).toBe(3);

    refs.get('routee-2')!.stop();
    await sleep(60);

    hits.clear();
    deadLetters.length = 0;
    for (let i = 0; i < 6; i++) pool.tell('go');
    await sleep(60);

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
    const deadLetters: unknown[] = [];
    const sys = newSystem('router-broadcast-prune');
    sys.spawn(Props.create(() => new (deadLetterCollector(deadLetters))()), 'dead-letters');
    const pool = sys.spawn(
      Router.broadcast(3, Props.create(() => new (registeringWorker(hits, refs))())),
      'pool',
    );

    pool.tell('warmup');
    await sleep(40);
    refs.get('routee-3')!.stop();
    await sleep(60);

    hits.clear();
    deadLetters.length = 0;
    pool.tell(new Broadcast('go') as never);
    await sleep(40);

    // A broadcast reaches every routee in the pool, so a stale member is one
    // guaranteed dead letter per broadcast rather than a probabilistic share.
    expect(Array.from(hits.keys()).sort()).toEqual(['routee-1', 'routee-2']);
    expect(deadLetters).toEqual([]);

    await sys.terminate();
  });
});

describe('Router — pool size (#455)', () => {
  const someProps = (): Props<string> => Props.create(() => new (countingWorker(new Map()))());

  test('every factory rejects a size that cannot produce a working pool', () => {
    // size <= 0 used to yield an empty pool: preStart's loop never ran, every
    // strategy returned nothing, and all traffic went silently to dead letters.
    for (const size of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => Router.roundRobin(size, someProps())).toThrow(OptionsError);
      expect(() => Router.random(size, someProps())).toThrow(OptionsError);
      expect(() => Router.broadcast(size, someProps())).toThrow(OptionsError);
      expect(() => Router.custom(size, someProps(), roundRobinStrategy())).toThrow(OptionsError);
    }
  });

  test('the error names the field and the rejected value', () => {
    try {
      Router.roundRobin(0, someProps());
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
      Router.roundRobin(1, Props.create(() => new (countingWorker(hits))())),
      'pool',
    );
    pool.tell('x'); pool.tell('y');
    await sleep(40);
    expect(hits.get('routee-1')).toBe(2);
    await sys.terminate();
  });
});
