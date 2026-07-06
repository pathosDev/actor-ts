import { expect, test } from 'bun:test';
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  AskTimeoutError,
  Broadcast,
  DeadLetter,
  Directive,
  LogLevel,
  NoopLogger,
  OneForOneStrategy,
  PoisonPill,
  Props,
  Router,
  Terminated,
  ask,
} from '../src/index.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function newSystem(name = 'test'): ActorSystem {
  return ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
}

test('delivers messages in order, one at a time', async () => {
  const received: number[] = [];
  class Collect extends Actor<number> {
    override onReceive(n: number): void { received.push(n); }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new Collect()), 'c');
  for (let i = 0; i < 10; i++) ref.tell(i);
  await sleep(80);
  expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await sys.terminate();
});

test('awaiting onReceive serializes subsequent messages', async () => {
  const events: string[] = [];
  class S extends Actor<number> {
    override async onReceive(n: number): Promise<void> {
      events.push(`start:${n}`);
      await sleep(5);
      events.push(`end:${n}`);
    }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new S()), 's');
  ref.tell(1);
  ref.tell(2);
  ref.tell(3);
  await sleep(80);
  expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  await sys.terminate();
});

test('preStart runs before first message, postStop runs after', async () => {
  const events: string[] = [];
  class Lifecycle extends Actor<string> {
    override preStart(): void { events.push('preStart'); }
    override postStop(): void { events.push('postStop'); }
    override onReceive(m: string): void { events.push(`recv:${m}`); }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new Lifecycle()), 'l');
  ref.tell('hi');
  await sleep(30);
  ref.stop();
  await sleep(30);
  expect(events).toEqual(['preStart', 'recv:hi', 'postStop']);
  await sys.terminate();
});

test('ask resolves with the reply', async () => {
  class Echo extends Actor<string> {
    override onReceive(m: string): void { this.sender.forEach((__s) => __s.tell(`echo:${m}`)); }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new Echo()), 'echo');
  const reply = await ref.ask<string>('hi', 500);
  expect(reply).toBe('echo:hi');
  await sys.terminate();
});

test('ask rejects when target replies with an Error', async () => {
  class Rejector extends Actor<string> {
    override onReceive(_: string): void { this.sender.forEach((__s) => __s.tell(new Error('nope'))); }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new Rejector()), 'r');
  let err: Error | null = null;
  try { await ref.ask('hi', 500); }
  catch (e) { err = e as Error; }
  expect(err).not.toBeNull();
  expect(err!.message).toBe('nope');
  await sys.terminate();
});

test('ask times out', async () => {
  class Silent extends Actor<string> { override onReceive(_: string): void {} }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new Silent()), 's');
  await expect(ref.ask('hi', 20)).rejects.toBeInstanceOf(AskTimeoutError);
  await sys.terminate();
});

test('supervisor restarts child on exception, default strategy', async () => {
  const starts: number[] = [];
  class Flaky extends Actor<number> {
    override preStart(): void { starts.push(1); }
    override onReceive(n: number): void { if (n < 0) throw new Error('neg'); }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new Flaky()), 'f');
  ref.tell(1);
  ref.tell(-1);
  ref.tell(2);
  await sleep(50);
  expect(starts.length).toBeGreaterThanOrEqual(2);
  await sys.terminate();
});

test('stoppingStrategy stops a failing child', async () => {
  let stopped = false;
  class Failer extends Actor<string> {
    override postStop(): void { stopped = true; }
    override onReceive(_: string): void { throw new Error('bad'); }
  }
  class Parent extends Actor<'go'> {
    override supervisorStrategy() {
      return new OneForOneStrategy(() => Directive.Stop);
    }
    override preStart(): void {
      const c = this.context.spawn(Props.create(() => new Failer()), 'c');
      c.tell('go');
    }
    override onReceive(_: 'go'): void {}
  }
  const sys = newSystem();
  sys.spawn(Props.create(() => new Parent()), 'parent');
  await sleep(50);
  expect(stopped).toBe(true);
  await sys.terminate();
});

test('watch delivers Terminated when target stops', async () => {
  const seen: string[] = [];
  class Watched extends Actor<string> {
    override onReceive(_: string): void { this.self.stop(); }
  }
  class Watcher extends Actor<string | Terminated> {
    override preStart(): void {
      const c = this.context.spawn(Props.create(() => new Watched()), 'w');
      this.context.watch(c);
      c.tell('die');
    }
    override onReceive(m: string | Terminated): void {
      if (m instanceof Terminated) seen.push(m.actor.path.name);
    }
  }
  const sys = newSystem();
  sys.spawn(Props.create(() => new Watcher()), 'parent');
  await sleep(40);
  expect(seen).toEqual(['w']);
  await sys.terminate();
});

test('become swaps behaviour', async () => {
  const out: string[] = [];
  class B extends Actor<string> {
    override onReceive(m: string): void {
      out.push(`a:${m}`);
      this.context.become((next: string) => { out.push(`b:${next}`); });
    }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new B()), 'b');
  ref.tell('1');
  ref.tell('2');
  ref.tell('3');
  await sleep(30);
  expect(out).toEqual(['a:1', 'b:2', 'b:3']);
  await sys.terminate();
});

test('router.roundRobin distributes evenly', async () => {
  const hits = new Map<string, number>();
  class Worker extends Actor<string> {
    override onReceive(_: string): void {
      const name = this.self.path.name;
      hits.set(name, (hits.get(name) ?? 0) + 1);
    }
  }
  const sys = newSystem();
  const pool = sys.spawn(Router.roundRobin(3, Props.create(() => new Worker())), 'pool');
  for (let i = 0; i < 9; i++) pool.tell('go');
  await sleep(40);
  expect(hits.size).toBe(3);
  for (const v of hits.values()) expect(v).toBe(3);
  await sys.terminate();
});

test('Broadcast delivers to every routee', async () => {
  let count = 0;
  class W extends Actor<string> {
    override onReceive(_: string): void { count++; }
  }
  const sys = newSystem();
  const pool = sys.spawn(Router.roundRobin(4, Props.create(() => new W())), 'p');
  pool.tell(new Broadcast('hello'));
  await sleep(40);
  expect(count).toBe(4);
  await sys.terminate();
});

test('PoisonPill stops the actor after processing earlier messages', async () => {
  const out: string[] = [];
  class S extends Actor<string> {
    override onReceive(m: string): void { out.push(m); }
    override postStop(): void { out.push('stopped'); }
  }
  const sys = newSystem();
  const ref = sys.spawn(Props.create(() => new S()), 's');
  ref.tell('a');
  ref.tell('b');
  ref.tell(PoisonPill.instance as unknown as string);
  ref.tell('c'); // goes to dead letters
  await sleep(30);
  expect(out).toEqual(['a', 'b', 'stopped']);
  await sys.terminate();
});

test('dead-letter event stream sees undeliverable messages', async () => {
  const seen: unknown[] = [];
  class Listener extends Actor<DeadLetter> {
    override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
    override onReceive(m: DeadLetter): void { seen.push(m.message); }
  }
  class Nothing extends Actor<string> {
    override onReceive(_: string): void {}
  }
  const sys = newSystem();
  sys.spawn(Props.create(() => new Listener()), 'listener');
  const ref = sys.spawn(Props.create(() => new Nothing()), 'n');
  ref.stop();
  await sleep(30);
  ref.tell('too-late');
  await sleep(30);
  expect(seen).toContain('too-late');
  await sys.terminate();
});

test('setReceiveTimeout fires ReceiveTimeout', async () => {
  let fired = false;
  class T extends Actor<unknown> {
    override preStart(): void { this.context.setReceiveTimeout(20); }
    override onReceive(m: unknown): void {
      const name = (m as { constructor?: { name?: string } })?.constructor?.name;
      if (name === 'ReceiveTimeout') { fired = true; this.self.stop(); }
    }
  }
  const sys = newSystem();
  sys.spawn(Props.create(() => new T()), 't');
  await sleep(80);
  expect(fired).toBe(true);
  await sys.terminate();
});

test('system.terminate() resolves and marks system terminated', async () => {
  const sys = newSystem();
  sys.spawn(
    Props.create(() => new (class extends Actor<string> {
      override onReceive(_: string): void {}
    })()),
    'x',
  );
  await sys.terminate();
  expect(sys.isTerminated).toBe(true);
});
