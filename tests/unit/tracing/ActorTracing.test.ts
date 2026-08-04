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
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('Actor tracing — auto-instrumentation', () => {
  test('actor.receive span has the caller\'s span as parent', async () => {
    const tracer = new RecordingTracer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-1', sysOptions);
    sys.extension(TracingExtensionId).enable(tracer);

    class Recv extends Actor<string> {
      override onReceive(_m: string): void { /* spans capture themselves */ }
    }

    try {
      const actorRef = sys.spawn(() => new Recv(), 'r');
      const client = tracer.startSpan('client.handle-request');
      tracer.withActiveSpan(client, () => {
        actorRef.tell('hello');
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
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-chain', sysOptions);
    sys.extension(TracingExtensionId).enable(tracer);

    class B extends Actor<string> {
      override onReceive(_m: string): void { /* */ }
    }
    class A extends Actor<{ message: string; next: ActorRef<string> }> {
      override onReceive(m: { message: string; next: ActorRef<string> }): void {
        m.next.tell(m.message);
      }
    }

    try {
      const actorB = sys.spawn(() => new B(), 'b');
      const actorA = sys.spawn(() => new A(), 'a');
      const client = tracer.startSpan('client');
      tracer.withActiveSpan(client, () => actorA.tell({ message: 'forward', next: actorB }));
      await sleep(60);
      client.end();

      const all = tracer.recorded();
      const traceId = client.context().traceId;
      // All actor.receive spans share the trace id.
      const recvs = all.filter((s) => s.name === 'actor.receive');
      expect(recvs.length).toBe(2);
      for (const actorRef of recvs) expect(actorRef.context.traceId).toBe(traceId);
      // One has client as parent (= the 'a' receive), the other has
      // 'a's spanId as parent (= the 'b' receive).
      const aRecv = recvs.find((actorRef) => actorRef.parent?.spanId === client.context().spanId);
      expect(aRecv).toBeDefined();
      const bRecv = recvs.find((actorRef) => actorRef.parent?.spanId === aRecv!.context.spanId);
      expect(bRecv).toBeDefined();
    } finally {
      await sys.terminate();
    }
  });

  test('handler error propagates to span: setStatus(error) + recordException', async () => {
    const tracer = new RecordingTracer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tr-err', sysOptions);
    sys.extension(TracingExtensionId).enable(tracer);

    class Bomb extends Actor<string> {
      override onReceive(_m: string): void { throw new Error('boom!'); }
    }

    try {
      const actorB = sys.spawn(() => new Bomb(), 'b');
      const root = tracer.startSpan('client');
      tracer.withActiveSpan(root, () => actorB.tell('boom'));
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
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    // NOT enabling on the system — tracer stays as the noop default.
    const sys = ActorSystem.create('tr-noop', sysOptions);

    class R extends Actor<string> {
      override onReceive(): void { /* */ }
    }

    try {
      const actorRef = sys.spawn(() => new R(), 'r');
      actorRef.tell('x');
      await sleep(30);
      expect(tracer.recorded()).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});

describe('Actor tracing — tooling actors', () => {
  test('an internal actor produces no span, even inside an active trace', async () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('internal-spans', options);
    const tracer = new RecordingTracer();
    system.extension(TracingExtensionId).enable(tracer);

    class Quiet extends Actor<string> {
      override onReceive(): void {}
    }
    const application = system.spawn(() => new Quiet(), 'application');
    const tooling = system.spawn(Quiet, 'tooling', { internal: true });

    const span = tracer.startSpan('client');
    await tracer.withActiveSpan(span, async () => {
      application.tell('a');
      tooling.tell('b');
    });
    span.end();
    await sleep(60);

    const paths = tracer.recorded()
      .map((recorded) => recorded.attributes['actor.path'])
      .filter((path): path is string => typeof path === 'string');
    expect(paths.some((path) => path.endsWith('/application'))).toBe(true);
    // Excluding tooling only from *roots* was not enough: a probe that
    // receives an event-stream publish during an application message
    // inherits its trace and reappears in the middle of the route.
    expect(paths.some((path) => path.endsWith('/tooling'))).toBe(false);

    await system.terminate();
  });

  test('children inherit the mark', async () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('internal-children', options);

    class Leaf extends Actor<string> {
      override onReceive(): void {}
    }
    class Root extends Actor<string> {
      child!: ActorRef<string>;
      override preStart(): void {
        this.child = this.context.spawn(() => new Leaf(), 'leaf');
      }
      override onReceive(message: string): void { this.child.tell(message); }
    }
    system.spawn(Root, 'root', { internal: true });
    await sleep(60);

    const marked = system._inspectTree()
      .filter((cell) => cell.internal)
      .map((cell) => cell.name)
      .sort();
    expect(marked).toEqual(['leaf', 'root']);

    await system.terminate();
  });
});
