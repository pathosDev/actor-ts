/**
 * Verify that LogContext (#53) propagates through tells from one actor
 * to another within a single ActorSystem.  The chain we exercise:
 *
 *   - User calls `LogContext.run({correlationId: 'abc'}, () =>
 *     a.tell(msg))`.  The tell snapshots the ctx onto the envelope.
 *   - `a` receives the message.  Its handler is wrapped in
 *     `LogContext.run(envelope.context, ...)`, so when it calls
 *     `b.tell(...)` from inside the handler, that next envelope
 *     snapshots the same ctx.
 *   - `b` records the ctx it observed during its handler.  We assert
 *     it matches the one set at the top.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { LogContext } from '../../src/LogContext.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('LogContext — actor-to-actor propagation', () => {
  test('tell from within run() carries the context to the receiver', async () => {
    const observed: Array<Record<string, unknown>> = [];

    class Receiver extends Actor<string> {
      override onReceive(_m: string): void {
        observed.push({ ...LogContext.get() });
      }
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-1', sysOptions);
    try {
      const r = sys.spawn(Props.create(() => new Receiver()), 'r');
      LogContext.run({ correlationId: 'abc-123' }, () => {
        r.tell('hello');
      });
      await sleep(40);
      expect(observed).toEqual([{ correlationId: 'abc-123' }]);
    } finally {
      await sys.terminate();
    }
  });

  test('downstream tell from inside the receiver inherits the same context', async () => {
    const observed: Array<Record<string, unknown>> = [];

    class Bottom extends Actor<string> {
      override onReceive(_m: string): void {
        observed.push({ ...LogContext.get() });
      }
    }

    class Middle extends Actor<{ msg: string; bottom: ActorRef<string> }> {
      override onReceive(c: { msg: string; bottom: ActorRef<string> }): void {
        observed.push({ ...LogContext.get() });
        // Tell from inside the handler — this snapshots the
        // re-installed context onto the next envelope.
        c.bottom.tell(c.msg);
      }
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-chain', sysOptions);
    try {
      const bottom = sys.spawn(Props.create(() => new Bottom()), 'b');
      const middle = sys.spawn(Props.create(() => new Middle()), 'm');
      LogContext.run({ requestId: 'req-9', user: 'u-1' }, () => {
        middle.tell({ msg: 'forward', bottom });
      });
      await sleep(60);
      expect(observed).toEqual([
        { requestId: 'req-9', user: 'u-1' },   // middle saw it
        { requestId: 'req-9', user: 'u-1' },   // bottom saw the same
      ]);
    } finally {
      await sys.terminate();
    }
  });

  test('outside any run(), tells carry no context (defensive default)', async () => {
    const observed: Array<Record<string, unknown>> = [];
    class R extends Actor<string> {
      override onReceive(): void { observed.push({ ...LogContext.get() }); }
    }
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-none', sysOptions);
    try {
      const r = sys.spawn(Props.create(() => new R()), 'r');
      r.tell('plain');
      await sleep(30);
      expect(observed).toEqual([{}]);
    } finally {
      await sys.terminate();
    }
  });

  test('two parallel tells in different contexts don\'t cross-contaminate', async () => {
    const observed = new Map<string, Record<string, unknown>>();
    class R extends Actor<{ id: string }> {
      override onReceive(m: { id: string }): void {
        observed.set(m.id, { ...LogContext.get() });
      }
    }
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mdc-parallel', sysOptions);
    try {
      const r = sys.spawn(Props.create(() => new R()), 'r');
      LogContext.run({ branch: 'A' }, () => r.tell({ id: 'a' }));
      LogContext.run({ branch: 'B' }, () => r.tell({ id: 'b' }));
      await sleep(50);
      expect(observed.get('a')).toEqual({ branch: 'A' });
      expect(observed.get('b')).toEqual({ branch: 'B' });
    } finally {
      await sys.terminate();
    }
  });
});
