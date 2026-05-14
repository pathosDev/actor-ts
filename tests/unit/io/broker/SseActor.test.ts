import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { Actor } from '../../../../src/Actor.js';
import { SseActor, type SseEvent } from '../../../../src/io/broker/SseActor.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

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

    const sys = ActorSystem.create('sse-1', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    sys.spawnAnonymous(Props.create(() => new SseActor({
      url: `http://localhost:${server.port}/`, target,
      reconnect: false,  // disable so the test ends predictably
    })));
    await sleep(150);

    expect(collector.received.length).toBe(4);
    expect(collector.received[0]).toEqual({ event: 'message', data: 'hello', id: undefined });
    expect(collector.received[1]).toEqual({ event: 'tick', data: '{"n":1}', id: '100' });
    expect(collector.received[2]).toEqual({ event: 'tick', data: '{"n":2}', id: '101' });
    expect(collector.received[3]!.data).toBe('line-1\nline-2');
    await sys.terminate();
    server.stop(true);
  });
});
