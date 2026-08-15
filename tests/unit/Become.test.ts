import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const newSystem = (name = 'become-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('become / unbecome', () => {
  test('become replaces the current behaviour (default discardOld=true)', async () => {
    const out: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void {
        out.push(`initial:${m}`);
        this.context.become((next: string) => { out.push(`next:${next}`); });
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(A, 'a');
    ref.tell('1'); ref.tell('2'); ref.tell('3');
    await awaitCondition(() => out.length === 3, {
      timeoutMs: 4_000,
      label: 'all three messages were handled',
    });
    expect(out).toEqual(['initial:1', 'next:2', 'next:3']);
    await sys.terminate();
  });

  test('become with discardOld=false pushes onto a stack', async () => {
    const out: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void {
        out.push(`base:${m}`);
        if (m === 'push-top') {
          this.context.become((n: string) => { out.push(`top:${n}`); }, false);
        }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(A, 'a');
    ref.tell('x');            // base
    ref.tell('push-top');     // base
    ref.tell('y');            // top
    await awaitCondition(() => out.length === 3, {
      timeoutMs: 4_000,
      label: 'all three messages were handled',
    });
    expect(out).toEqual(['base:x', 'base:push-top', 'top:y']);
    await sys.terminate();
  });

  test('unbecome pops the stack', async () => {
    const out: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void {
        if (m === 'enter-top') {
          this.context.become((n: string) => {
            if (n === 'leave') {
              this.context.unbecome();
              out.push('left');
              return;
            }
            out.push(`top:${n}`);
          }, false);
          out.push('pushed');
        } else {
          out.push(`base:${m}`);
        }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(A, 'a');
    ref.tell('x');           // base
    ref.tell('enter-top');   // base (pushes top)
    ref.tell('y');           // top
    ref.tell('leave');       // top (pops)
    ref.tell('z');           // base
    await awaitCondition(() => out.length === 5, {
      timeoutMs: 4_000,
      label: 'all five messages were handled',
    });
    expect(out).toEqual(['base:x', 'pushed', 'top:y', 'left', 'base:z']);
    await sys.terminate();
  });

  test('unbecome cannot empty the stack below the initial behaviour', async () => {
    const out: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void {
        if (m === 'try-pop') {
          this.context.unbecome();
          this.context.unbecome();
        } else {
          out.push(`base:${m}`);
        }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(A, 'a');
    ref.tell('first'); ref.tell('try-pop'); ref.tell('after');
    // `try-pop` records nothing, so two entries means `after` came back to the
    // base behaviour — exactly the property under test.
    await awaitCondition(() => out.length === 2, {
      timeoutMs: 4_000,
      label: 'the base behaviour handled the message after the pop attempts',
    });
    // base behaviour still functions after the pop attempts.
    expect(out).toEqual(['base:first', 'base:after']);
    await sys.terminate();
  });
});
