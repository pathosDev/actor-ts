/**
 * Verify that the actor framework's auto-instrumentation produces
 * coherent traces — `actor.receive` spans propagate parent/child
 * relationships across actor-to-actor tells (#10).
 *
 * The chain we exercise:
 *
 *   - Outer caller starts a `client` span and tells actor A from
 *     inside it.  The `actor.receive` span on A's onReceive should
 *     have the client span as its parent.
 *
 *   - A tells B from within its handler.  The `actor.receive` span on
 *     B should have A's `actor.receive` span as its parent.
 *
 *   - All three spans share the same traceId (one logical trace).
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('Actor tracing — auto-instrumentation', () => {
  test('actor.receive span has the caller\'s span as parent', async () => {
    const tracer = new RecordingTracer();
    const sys = ActorSystem.create('tr-1', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys.extension(TracingExtensionId).enable(tracer);

    class Recv extends Actor<string> {
      override onReceive(_m: string): void { /* spans capture themselves */ }
    }

    try {
      const r = sys.actorOf(Props.create(() => new Recv()), 'r');
      const client = tracer.startSpan('client.handle-request');
      tracer.withActiveSpan(client, () => {
        r.tell('hello');
      });
      await sleep(40);
      client.end();

      const recorded = tracer.recorded();
      const recv = recorded.find((s) => s.name === 'actor.receive');
      expect(recv).toBeDefined();
      // The receive span's parent is the client span.
      expect(recv!.parent?.spanId).toBe(client.context().spanId);
      // Same trace id throughout.
      expect(recv!.context.traceId).toBe(client.context().traceId);
      // Useful attributes present.
      expect(recv!.attributes['actor.path']).toBeDefined();
    } finally {
      await sys.terminate();
    }
  });

  test('chained actors: span tree A→B inside one trace', async () => {
    const tracer = new RecordingTracer();
    const sys = ActorSystem.create('tr-chain', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys.extension(TracingExtensionId).enable(tracer);

    class B extends Actor<string> {
      override onReceive(_m: string): void { /* */ }
    }
    class A extends Actor<{ msg: string; next: ActorRef<string> }> {
      override onReceive(m: { msg: string; next: ActorRef<string> }): void {
        m.next.tell(m.msg);
      }
    }

    try {
      const b = sys.actorOf(Props.create(() => new B()), 'b');
      const a = sys.actorOf(Props.create(() => new A()), 'a');
      const client = tracer.startSpan('client');
      tracer.withActiveSpan(client, () => a.tell({ msg: 'forward', next: b }));
      await sleep(60);
      client.end();

      const all = tracer.recorded();
      const traceId = client.context().traceId;
      // All actor.receive spans share the trace id.
      const recvs = all.filter((s) => s.name === 'actor.receive');
      expect(recvs.length).toBe(2);
      for (const r of recvs) expect(r.context.traceId).toBe(traceId);
      // One has client as parent (= the 'a' receive), the other has
      // 'a's spanId as parent (= the 'b' receive).
      const aRecv = recvs.find((r) => r.parent?.spanId === client.context().spanId);
      expect(aRecv).toBeDefined();
      const bRecv = recvs.find((r) => r.parent?.spanId === aRecv!.context.spanId);
      expect(bRecv).toBeDefined();
    } finally {
      await sys.terminate();
    }
  });

  test('handler error propagates to span: setStatus(error) + recordException', async () => {
    const tracer = new RecordingTracer();
    const sys = ActorSystem.create('tr-err', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys.extension(TracingExtensionId).enable(tracer);

    class Bomb extends Actor<string> {
      override onReceive(_m: string): void { throw new Error('boom!'); }
    }

    try {
      const b = sys.actorOf(Props.create(() => new Bomb()), 'b');
      const root = tracer.startSpan('client');
      tracer.withActiveSpan(root, () => b.tell('boom'));
      await sleep(50);
      root.end();
      const recv = tracer.recorded().find((s) => s.name === 'actor.receive');
      expect(recv?.status).toBe('error');
      expect(recv?.statusMessage).toContain('boom!');
      expect(recv?.exceptions[0]?.message).toBe('boom!');
    } finally {
      await sys.terminate();
    }
  });

  test('without enabling the tracer, no spans are recorded', async () => {
    const tracer = new RecordingTracer();
    // NOT enabling on the system — tracer stays as the noop default.
    const sys = ActorSystem.create('tr-noop', { logger: new NoopLogger(), logLevel: LogLevel.Off });

    class R extends Actor<string> {
      override onReceive(): void { /* */ }
    }

    try {
      const r = sys.actorOf(Props.create(() => new R()), 'r');
      r.tell('x');
      await sleep(30);
      expect(tracer.recorded()).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});
