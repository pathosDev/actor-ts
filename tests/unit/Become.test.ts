import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem, ActorSystemOptions } from '../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'become-unit'): ActorSystem =>
  ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

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
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('1'); ref.tell('2'); ref.tell('3');
    await sleep(40);
    expect(out).toEqual(['initial:1', 'next:2', 'next:3']);
    await sys.terminate();
  });

  test('become with discardOld=false pushes onto a stack', async () => {
    const out: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void {
        out.push(`base:${m}`);
        if (m === 'push-top') {
          this.context.become((n: string) => out.push(`top:${n}`), false);
        }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('x');            // base
    ref.tell('push-top');     // base
    ref.tell('y');            // top
    await sleep(40);
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
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('x');           // base
    ref.tell('enter-top');   // base (pushes top)
    ref.tell('y');           // top
    ref.tell('leave');       // top (pops)
    ref.tell('z');           // base
    await sleep(40);
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
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('first'); ref.tell('try-pop'); ref.tell('after');
    await sleep(40);
    // base behaviour still functions after the pop attempts.
    expect(out).toEqual(['base:first', 'base:after']);
    await sys.terminate();
  });
});
