import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Actor } from '../../../../../src/Actor.js';
import { SseActor, type SseEvent } from '../../../../../src/io/broker/SseActor.js';
import { SseOptions } from '../../../../../src/io/broker/SseOptions.js';
import {
  BrokerDisconnected,
  BrokerReconnectAttempt,
} from '../../../../../src/io/broker/BrokerEvents.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

class CollectActor extends Actor<SseEvent> {
  received: SseEvent[] = [];
  override onReceive(m: SseEvent): void { this.received.push(m); }
}

describe('SseActor — round-trip via Bun.serve', () => {
  test('parses event, data, id fields', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller): void {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: hello\n\n'));
            controller.enqueue(enc.encode('event: tick\ndata: {"n":1}\nid: 100\n\n'));
            controller.enqueue(enc.encode('event: tick\ndata: {"n":2}\nid: 101\n\n'));
            // Multiline data — joined with newline.
            controller.enqueue(enc.encode('data: line-1\ndata: line-2\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('sse-1', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    const sseOptions = SseOptions.create()
      .withUrl(`http://localhost:${server.port}/`)
      .withTarget(target)
      .withReconnect(false);  // disable so the test ends predictably
    sys.spawnAnonymous(() => new SseActor(sseOptions));
    // The stream closes after its fourth event and the actor emits no
    // completion signal, so the arrival of the fourth event is the strongest
    // thing this test can observe — and it is the state the assertion reads.
    await awaitCondition(() => collector.received.length === 4, {
      label: 'all four SSE events were parsed and forwarded',
    });

    expect(collector.received.length).toBe(4);
    expect(collector.received[0]).toEqual({ event: 'message', data: 'hello', id: undefined });
    expect(collector.received[1]).toEqual({ event: 'tick', data: '{"n":1}', id: '100' });
    expect(collector.received[2]).toEqual({ event: 'tick', data: '{"n":2}', id: '101' });
    expect(collector.received[3]!.data).toBe('line-1\nline-2');
    await sys.terminate();
    server.stop(true);
  });
});

/* ------------------- liveness: read-idle + connect deadline (#753) ------- */

function quietSystem(name: string): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
}

/** Records the cause of every `BrokerDisconnected` the system publishes. */
function disconnectCauses(sys: ActorSystem): string[] {
  const causes: string[] = [];
  sys.eventStream.subscribe(
    sys.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(m: unknown): void {
        causes.push((m as BrokerDisconnected).cause?.message ?? '<no cause>');
      }
    })()),
    BrokerDisconnected,
  );
  return causes;
}

describe('SseActor — read-idle timeout (#753)', () => {
  test('a stream that opens and then sends nothing is reported as lost', async () => {
    // One comment line to get the response flushed, and then silence for ever.
    // `reader.read()` parks, no `done` arrives, no error is raised — the
    // sharpest form of the defect, because SSE is read-only and nothing else
    // in the actor can notice.  The opening chunk is not decoration: a body
    // with no bytes at all never flushes its headers, so `fetch` would park in
    // `connecting` and the test would be measuring a different defect.
    const server = Bun.serve({
      port: 0,
      fetch(): Response {
        const stream = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode(': ready\n\n'));
            /* …and never again */
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const sys = quietSystem('sse-idle-1');
    try {
      const target = sys.spawnAnonymous(() => new CollectActor());
      const causes = disconnectCauses(sys);
      const sseOptions = SseOptions.create()
        .withUrl(`http://localhost:${server.port}/`)
        .withTarget(target)
        .withIdleTimeoutMs(60)
        .withReconnect(false);
      sys.spawnAnonymous(() => new SseActor(sseOptions));

      await awaitCondition(() => causes.length > 0, {
        timeoutMs: 4_000, label: 'the idle deadline reported the silent stream as lost',
      });
      expect(causes[0]).toContain('idle timeout');
    } finally {
      await sys.terminate();
      server.stop(true);
    }
  });

  test('a comment keepalive refreshes the deadline even though it parses to no event', async () => {
    // What the docs promise operators: `: ping\n\n` every so often is enough
    // to hold an otherwise-idle feed open.  It parses to `null`, so the only
    // thing that can make it count is the deadline being refreshed per chunk
    // rather than per delivered event.
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const server = Bun.serve({
      port: 0,
      fetch(): Response {
        const stream = new ReadableStream<Uint8Array>({
          start(controller): void {
            const encoder = new TextEncoder();
            const timer = setInterval(() => {
              try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
            }, 50);
            timers.push(timer);
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const sys = quietSystem('sse-idle-2');
    try {
      const collector = new CollectActor();
      const target = sys.spawnAnonymous(() => collector);
      const causes = disconnectCauses(sys);
      const sseOptions = SseOptions.create()
        .withUrl(`http://localhost:${server.port}/`)
        .withTarget(target)
        .withIdleTimeoutMs(500)
        .withReconnect(false);
      sys.spawnAnonymous(() => new SseActor(sseOptions));

      // Two full deadline windows at a tenfold margin over the keepalive.
      await new Promise<void>((resolve) => { setTimeout(resolve, 1_200); });
      expect(causes).toEqual([]);
      // Comments carry no `data:`, so nothing was ever delivered — the point.
      expect(collector.received).toEqual([]);
    } finally {
      for (const timer of timers) clearInterval(timer);
      await sys.terminate();
      server.stop(true);
    }
  }, 10_000);
});

describe('SseActor — connect deadline (#753)', () => {
  test('a server that never answers the request fails the attempt', async () => {
    // The handler never returns, so `fetch` never resolves: without a deadline
    // the actor sits in `connecting` for as long as the server cares to hold
    // the request, and the reconnect policy never sees a failure to act on.
    const server = Bun.serve({
      port: 0,
      fetch(): Promise<Response> { return new Promise<Response>(() => { /* never */ }); },
    });
    const sys = quietSystem('sse-connect-deadline');
    try {
      const target = sys.spawnAnonymous(() => new CollectActor());
      const attempts: number[] = [];
      sys.eventStream.subscribe(
        sys.spawnAnonymous(() => new (class extends Actor<unknown> {
          override onReceive(m: unknown): void {
            attempts.push((m as BrokerReconnectAttempt).attempt);
          }
        })()),
        BrokerReconnectAttempt,
      );
      const sseOptions = SseOptions.create()
        .withUrl(`http://localhost:${server.port}/`)
        .withTarget(target)
        .withConnectTimeoutMs(60)
        // A long backoff so exactly one failure is observed, rather than a
        // retry storm against a server that will never answer.
        .withReconnect({ initialDelayMs: 30_000, maxDelayMs: 30_000, randomFactor: 0 });
      sys.spawnAnonymous(() => new SseActor(sseOptions));

      // A reconnect attempt is only ever announced after a connect *failed*,
      // so its arrival is the deadline having fired.
      await awaitCondition(() => attempts.length > 0, {
        timeoutMs: 4_000, label: 'the connect deadline failed the stalled attempt',
      });
      expect(attempts[0]).toBe(1);
    } finally {
      await sys.terminate();
      server.stop(true);
    }
  });
});
