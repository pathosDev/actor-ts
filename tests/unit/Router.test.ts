import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
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
      const n = this.self.path.name;
      hits.set(n, (hits.get(n) ?? 0) + 1);
    }
  };
}

describe('roundRobinStrategy', () => {
  test('cycles through routees deterministically', () => {
    const routees = ['a', 'b', 'c'].map(n => ({ path: { name: n } } as never));
    const s = roundRobinStrategy();
    const chosen = [0, 1, 2, 3, 4, 5].map(i =>
      Array.from(s(routees, { messageIndex: i }))[0]!,
    );
    expect((chosen.map((r: any) => r.path.name))).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  test('returns empty for empty routees', () => {
    expect(Array.from(roundRobinStrategy()([], { messageIndex: 0 }))).toEqual([]);
  });
});

describe('randomStrategy', () => {
  test('returns one routee per call from the given set', () => {
    const routees = ['a', 'b', 'c'].map(n => ({ path: { name: n } } as never));
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
    const routees = ['a', 'b', 'c'].map(n => ({ path: { name: n } } as never));
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
    for (const v of hits.values()) expect(v).toBe(3);
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
    for (const v of hits.values()) sum += v;
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
    for (const v of hits.values()) expect(v).toBe(1);
    await sys.terminate();
  });
});
