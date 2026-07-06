import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSelection } from '../../src/ActorSelection.js';
import { ActorSystem, ActorSystemOptions } from '../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { TestKit, TestKitOptions } from '../../src/testkit/TestKit.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSys = (n = 'sel'): ActorSystem =>
  ActorSystem.create(n, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

describe('ActorSelection — basics', () => {
  test('resolveOne returns a ref for an existing actor', async () => {
    const sys = newSys();
    class Noop extends Actor<unknown> { override onReceive(): void {} }
    const ref = sys.spawn(Props.create(() => new Noop()), 'foo');

    const sel = sys.actorSelection('/user/foo');
    const resolved = await sel.resolveOne(500);
    expect(resolved.path.toString()).toBe(ref.path.toString());
    await sys.terminate();
  });

  test('resolveOne works with a fully-qualified URI', async () => {
    const sys = newSys('uri-sys');
    class Noop extends Actor<unknown> { override onReceive(): void {} }
    sys.spawn(Props.create(() => new Noop()), 'foo');

    const sel = sys.actorSelection(`actor-ts://uri-sys/user/foo`);
    const resolved = await sel.resolveOne(500);
    expect(resolved.path.name).toBe('foo');
    await sys.terminate();
  });

  test('resolveOne times out for missing paths', async () => {
    const sys = newSys();
    const sel = sys.actorSelection('/user/never-existed');
    let caught: unknown = null;
    try { await sel.resolveOne(50); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('ActorSelection timed out');
    await sys.terminate();
  });

  test('tell delivers to a resolved actor', async () => {
    const kit = TestKit.create('tell-sel', TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const probe = kit.createTestProbe<string>();

    class Echo extends Actor<string> { override onReceive(m: string): void { probe.tell(m); } }
    kit.system.spawn(Props.create(() => new Echo()), 'echo');

    kit.system.actorSelection('/user/echo').tell('hello');
    expect(await probe.expectMsg('hello', 500)).toBe('hello');
    await kit.system.terminate();
  });

  test('tell drops into dead letters when no match', async () => {
    const kit = TestKit.create('dl-sel', TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const probe = kit.createTestProbe();
    const { DeadLetter } = await import('../../src/SystemMessages.js');
    kit.system.eventStream.subscribe(probe, DeadLetter);

    kit.system.actorSelection('/user/ghost').tell('boo');
    const dl = await probe.receiveOne(500) as { message: unknown };
    expect(dl.message).toBe('boo');
    await kit.system.terminate();
  });
});

describe('ActorSelection — nested paths', () => {
  test('resolves grandchildren through context.actorSelection', async () => {
    const kit = TestKit.create('nested-sel', TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const probe = kit.createTestProbe<string>();

    class Leaf extends Actor<string> { override onReceive(m: string): void { probe.tell(m); } }
    class Parent extends Actor<string> {
      override preStart(): void {
        this.context.spawn(Props.create(() => new Leaf()), 'leaf');
      }
      override onReceive(): void {}
    }
    kit.system.spawn(Props.create(() => new Parent()), 'parent');

    await sleep(20);
    kit.system.actorSelection('/user/parent/leaf').tell('hi');
    expect(await probe.expectMsg('hi', 500)).toBe('hi');
    await kit.system.terminate();
  });
});

describe('ActorSelection — parseSelectionPath edge cases', () => {
  test('different system name returns null segments (no match)', async () => {
    const sys = newSys('right-sys');
    const sel = sys.actorSelection(`actor-ts://other-sys/user/foo`);
    let caught: unknown = null;
    try { await sel.resolveOne(50); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    await sys.terminate();
  });

  test('leading-slash and no-leading-slash parse the same', async () => {
    const sys = newSys();
    class Noop extends Actor<unknown> { override onReceive(): void {} }
    sys.spawn(Props.create(() => new Noop()), 'x');
    const a = sys.actorSelection('/user/x');
    const b = sys.actorSelection('user/x');
    expect((await a.resolveOne(500)).path.toString()).toBe((await b.resolveOne(500)).path.toString());
    await sys.terminate();
  });
});

describe('ActorSelection — instance type', () => {
  test('returns an ActorSelection', () => {
    const sys = newSys();
    const sel = sys.actorSelection('/user/any');
    expect(sel).toBeInstanceOf(ActorSelection);
    void sys.terminate();
  });
});
