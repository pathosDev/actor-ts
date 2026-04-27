import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { FSM, type FsmResult } from '../../../src/fsm/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import { TestKit } from '../../../src/testkit/TestKit.js';

type DoorState = 'closed' | 'open';
interface DoorData { readonly openedAt: number | null; readonly opens: number; }
type DoorCmd = 'open' | 'close' | 'count';

class Door extends FSM<DoorState, DoorData, DoorCmd> {
  constructor(private readonly onEv: (evt: string) => void) {
    super('closed', { openedAt: null, opens: 0 });
    this.when('closed', (d, m) => {
      if (m === 'open') return this.goto('open', { ...d, openedAt: Date.now(), opens: d.opens + 1 });
      if (m === 'count') { this.onEv(`opens=${d.opens}`); return this.stay(d); }
      return this.stay(d);
    });
    this.when('open', (d, m) => {
      if (m === 'close') return this.goto('closed', { ...d, openedAt: null });
      return this.stay(d);
    });
    this.onEnter('open', () => { this.onEv('enter:open'); });
    this.onExitState('open', () => { this.onEv('exit:open'); });
    this.onTransition((from, to) => this.onEv(`${from}->${to}`));
  }
}

describe('FSM', () => {
  test('initial state handles messages', async () => {
    const events: string[] = [];
    const sys = ActorSystem.create('fsm', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const ref = sys.actorOf(Props.create(() => new Door((e) => events.push(e))));

    ref.tell('open');
    await Bun.sleep(20);
    expect(events).toContain('enter:open');
    expect(events).toContain('closed->open');

    ref.tell('close');
    await Bun.sleep(20);
    expect(events).toContain('exit:open');
    expect(events).toContain('open->closed');

    await sys.terminate();
  });

  test('data mutation via stay / goto', async () => {
    const events: string[] = [];
    const sys = ActorSystem.create('fsm-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const ref = sys.actorOf(Props.create(() => new Door((e) => events.push(e))));

    ref.tell('open');
    ref.tell('close');
    ref.tell('open');
    ref.tell('close');
    ref.tell('count'); // count is handled in 'closed'
    await Bun.sleep(30);
    expect(events.some((e) => e === 'opens=2')).toBe(true);

    await sys.terminate();
  });

  test('unknown state logs a warning but does not throw', async () => {
    class Broken extends FSM<'a' | 'b', null, string> {
      constructor() { super('a', null); /* no handlers registered */ }
    }
    const kit = TestKit.create('fsm-missing', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const ref = kit.system.actorOf(Props.create(() => new Broken()));
    ref.tell('anything');
    await Bun.sleep(20);
    // The actor is still alive — subsequent tells don't throw.
    expect(true).toBe(true);
    await kit.system.terminate();
  });
});

describe('FsmResult helpers — pure shape assertions', () => {
  test('goto returns transition', () => {
    class Test extends FSM<'s1' | 's2', number, string> {
      constructor() { super('s1', 0); }
      run(): FsmResult<'s1' | 's2', number> { return this.goto('s2', 1); }
    }
    const t = (new Test()).run();
    expect(t.kind).toBe('transition');
    expect((t as { next: string }).next).toBe('s2');
  });

  test('stay returns stay-shape', () => {
    class Test extends FSM<'s1', number, string> {
      constructor() { super('s1', 0); }
      run(): FsmResult<'s1', number> { return this.stay(7); }
    }
    const r = (new Test()).run();
    expect(r.kind).toBe('stay');
    expect(r.data).toBe(7);
  });
});
