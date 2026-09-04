import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  BrokerReconnectFailed,
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

/* --------------- what the actor refuses to connect to (#787) ------------- */

/**
 * Records the cause of every `BrokerReconnectFailed` the system publishes.
 *
 * A *connect* that fails never reaches `handleConnectionLost`, so it publishes
 * no `BrokerDisconnected` — the cause travels on the event that ends the
 * reconnect cycle instead.  Which is also the second half of what these tests
 * assert: a refused endpoint degrades through the ordinary backoff, exactly
 * like an unreachable one, rather than failing silently.
 */
function reconnectFailureCauses(sys: ActorSystem): string[] {
  const causes: string[] = [];
  sys.eventStream.subscribe(
    sys.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(m: unknown): void {
        causes.push((m as BrokerReconnectFailed).cause.message);
      }
    })()),
    BrokerReconnectFailed,
  );
  return causes;
}

/** One connect attempt, one retry, then give up — with no jitter to wait out. */
const failFast = { initialDelayMs: 20, maxDelayMs: 20, maxAttempts: 1, randomFactor: 0 } as const;

describe('SseActor — refuses a redirect (#787)', () => {
  test('a 302 fails the connect, and the redirect target is never contacted', async () => {
    // The feed answers the SSE GET with a redirect to a host it chose.  With
    // `fetch`'s default `redirect: 'follow'` the runtime would have re-issued
    // the request there, replaying every custom header — the Fetch standard
    // strips only `Authorization`, `Cookie` and `Proxy-Authorization`, so the
    // `x-api-key` below would have gone with it — and then parsed whatever
    // came back as events.  Both halves are asserted: the connect fails, and
    // the collector never sees a request at all.
    const replayedTo: Array<Record<string, string>> = [];
    const collector = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        replayedTo.push(Object.fromEntries(request.headers.entries()));
        return new Response('data: injected\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const feed = Bun.serve({
      port: 0,
      fetch(): Response {
        return new Response(null, {
          status: 302,
          headers: { location: `http://localhost:${collector.port}/` },
        });
      },
    });
    const sys = quietSystem('sse-redirect');
    try {
      const received = new CollectActor();
      const target = sys.spawnAnonymous(() => received);
      const causes = reconnectFailureCauses(sys);
      const sseOptions = SseOptions.create()
        .withUrl(`http://localhost:${feed.port}/`)
        .withTarget(target)
        .withHeaders({ 'x-api-key': 'vendor-secret' })
        .withReconnect(failFast);
      sys.spawnAnonymous(() => new SseActor(sseOptions));

      // Wait for *either* outcome rather than only the one that should
      // happen: an implementation that follows the redirect settles the other
      // branch immediately, so this fails in milliseconds with the replayed
      // headers in the diff instead of timing out with nothing to read.
      await awaitCondition(() => causes.length > 0 || replayedTo.length > 0, {
        timeoutMs: 4_000, label: 'the connect either refused the redirect or followed it',
      });
      // The credential travels to the configured host and no further.
      expect(replayedTo).toEqual([]);
      expect(causes[0]).toContain('refused a redirect');
      expect(causes[0]).toContain('HTTP 302');
      // And nothing the redirect target would have served reached the target.
      expect(received.received).toEqual([]);
    } finally {
      await sys.terminate();
      feed.stop(true);
      collector.stop(true);
    }
  });
});

/**
 * The two shapes a body that is not a feed arrives in, and what the refusal
 * has to say about each.
 *
 * The absent case is not padding: it is the one an implementation is most
 * likely to "relax" later, and relaxing it hands the check back to the only
 * party it constrains — an endpoint that wants its document parsed as events
 * just omits the header.
 */
const foreignContentTypes = [
  {
    label: 'a type that is not text/event-stream',
    systemName: 'sse-content-type-wrong',
    respond: (): Response => new Response('data: injected\n\n', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
    expected: 'text/html',
  },
  {
    label: 'no content type at all',
    systemName: 'sse-content-type-absent',
    // A `ReadableStream` body is what makes the header genuinely absent: Bun
    // defaults a string body to `text/plain;charset=utf-8`, which would test
    // the case above again under a different name.  It is also the realistic
    // shape — an endpoint impersonating a feed streams.
    respond: (): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('data: injected\n\n'));
        controller.close();
      },
    })),
    expected: '<absent>',
  },
] as const;

describe('SseActor — refuses a foreign content type (#787)', () => {
  for (const { label, systemName, respond, expected } of foreignContentTypes) {
    test(`${label} fails the connect`, async () => {
      // The body is *valid* SSE wire format, so nothing downstream would have
      // rejected it — `consume` splits on `\n\n` and forwards whatever parses.
      // Only the announced type separates a feed from any other document an
      // endpoint chooses to answer with, which is why the check is here and
      // not in the parser.
      const server = Bun.serve({ port: 0, fetch: (): Response => respond() });
      const sys = quietSystem(systemName);
      try {
        const received = new CollectActor();
        const target = sys.spawnAnonymous(() => received);
        const causes = reconnectFailureCauses(sys);
        const sseOptions = SseOptions.create()
          .withUrl(`http://localhost:${server.port}/`)
          .withTarget(target)
          .withReconnect(failFast);
        sys.spawnAnonymous(() => new SseActor(sseOptions));

        // Either outcome, for the same reason as above: without the assertion
        // the body parses cleanly and the injected event arrives, so this
        // reads as "the event got through" rather than as a stalled wait.
        await awaitCondition(() => causes.length > 0 || received.received.length > 0, {
          timeoutMs: 4_000, label: 'the connect either refused the body or parsed it',
        });
        expect(received.received).toEqual([]);
        expect(causes[0]).toContain('non-event-stream body');
        expect(causes[0]).toContain(expected);
      } finally {
        await sys.terminate();
        server.stop(true);
      }
    });
  }
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

/* ------ the events a refused connect publishes, and what we say it does ---- */

/**
 * The three surfaces #749 and #787 shipped told operators that both refusals
 * "travel the ordinary reconnect path — backoff, circuit breaker,
 * `BrokerDisconnected`".  The first two hold; the third names an event no
 * refused connect can produce, because `BrokerDisconnected` has exactly one
 * publish site — `handleConnectionLost` — and a connect that fails goes from
 * `_tryConnect`'s catch straight into the reconnect handler.  An operator who
 * alerted on the documented name would have had an alert that never fires.
 *
 * So the prose is pinned to the measured set rather than to a phrasing: the
 * first test below observes what a refused connect actually publishes, and the
 * ones after it require each surface to name those events and no others.  A
 * change that really does route a refusal through `handleConnectionLost` fails
 * the first test, which is the only thing that may move the constants — and
 * moving them then forces all three surfaces in the same commit.
 */
const PUBLISHED_ON_A_REFUSED_CONNECT = ['BrokerReconnectAttempt', 'BrokerReconnectFailed'] as const;
const ABSENT_ON_A_REFUSED_CONNECT = ['BrokerDisconnected'] as const;

type BrokerLifecycleEventName =
  | typeof PUBLISHED_ON_A_REFUSED_CONNECT[number]
  | typeof ABSENT_ON_A_REFUSED_CONNECT[number]
  | 'other';

function brokerLifecycleEventName(event: unknown): BrokerLifecycleEventName {
  if (event instanceof BrokerDisconnected) return 'BrokerDisconnected';
  if (event instanceof BrokerReconnectAttempt) return 'BrokerReconnectAttempt';
  if (event instanceof BrokerReconnectFailed) return 'BrokerReconnectFailed';
  return 'other';
}

/**
 * Names of the three lifecycle events the system publishes, in arrival order.
 *
 * One observer subscribed to all three, deliberately: the claim under test is
 * about which of them arrive, so watching only the expected ones would prove
 * nothing about the one that must not.
 */
function brokerLifecycleEventNames(sys: ActorSystem): BrokerLifecycleEventName[] {
  const names: BrokerLifecycleEventName[] = [];
  const observer = sys.spawnAnonymous(() => new (class extends Actor<unknown> {
    override onReceive(m: unknown): void { names.push(brokerLifecycleEventName(m)); }
  })());
  for (const eventClass of [BrokerDisconnected, BrokerReconnectAttempt, BrokerReconnectFailed]) {
    sys.eventStream.subscribe(observer, eventClass);
  }
  return names;
}

describe('SseActor — what a refused connect publishes (#749, #787)', () => {
  test('a redirect-refusing feed produces reconnect events and no BrokerDisconnected', async () => {
    const feed = Bun.serve({
      port: 0,
      fetch(): Response {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1/' } });
      },
    });
    const sys = quietSystem('sse-refusal-event-names');
    try {
      const target = sys.spawnAnonymous(() => new CollectActor());
      const names = brokerLifecycleEventNames(sys);
      const sseOptions = SseOptions.create()
        .withUrl(`http://localhost:${feed.port}/`)
        .withTarget(target)
        .withReconnect(failFast);
      sys.spawnAnonymous(() => new SseActor(sseOptions));

      // `failFast` allows one retry, so the cycle ends: the terminal event is
      // what makes "and nothing else arrived" a statement about a finished
      // sequence rather than about one that had not got there yet.
      await awaitCondition(() => names.includes('BrokerReconnectFailed'), {
        timeoutMs: 4_000, label: 'the refused connect ran its reconnect cycle out',
      });
      expect(new Set(names)).toEqual(new Set(PUBLISHED_ON_A_REFUSED_CONNECT));
      for (const absent of ABSENT_ON_A_REFUSED_CONNECT) expect(names).not.toContain(absent);
    } finally {
      await sys.terminate();
      feed.stop(true);
    }
  });
});

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

/**
 * Where each surface states the claim, and how to cut the statement out of it.
 *
 * `anchor` is the sentence opening — translated, since the pages are mirrored
 * 1:1 — and the enumeration that follows it sits between the next two em
 * dashes.  That enumeration is the unit under test because it is the
 * operator-facing list of event names: it is what a reader copies into an
 * alert, and it is exactly where the wrong name sat.
 */
const claimSurfaces = [
  {
    label: 'the English SSE page',
    file: join('docs', 'src', 'content', 'docs', 'io', 'sse.mdx'),
    anchor: 'Both refusals travel the ordinary reconnect path',
  },
  {
    label: 'the German SSE page',
    file: join('docs', 'src', 'content', 'docs', 'de', 'io', 'sse.mdx'),
    anchor: 'Ablehnungen laufen über den gewöhnlichen Reconnect-Pfad',
  },
  {
    label: 'the CHANGELOG entry',
    file: 'CHANGELOG.md',
    anchor: 'Both refusals travel the ordinary reconnect path',
  },
] as const;

/** The em-dash enumeration that follows `anchor`. */
function enumeratedEvents(file: string, anchor: string): string {
  // Flattened before the search, not after: every surface hard-wraps, so both
  // the anchor and the enumeration straddle line breaks in at least one of
  // them, and matching against the raw text would make the guard depend on
  // where a paragraph happens to wrap.
  const text = readFileSync(join(REPOSITORY_ROOT, file), 'utf8').replace(/\s+/g, ' ');
  const anchorAt = text.indexOf(anchor);
  expect(anchorAt, `${file} no longer contains "${anchor}"`).toBeGreaterThanOrEqual(0);
  const opening = text.indexOf('—', anchorAt);
  expect(opening, `${file}: no enumeration after "${anchor}"`).toBeGreaterThanOrEqual(0);
  const closing = text.indexOf('—', opening + 1);
  expect(closing, `${file}: unterminated enumeration after "${anchor}"`).toBeGreaterThanOrEqual(0);
  return text.slice(opening + 1, closing).trim();
}

describe('SseActor — the shipped prose names the events that exist (#749, #787)', () => {
  for (const { label, file, anchor } of claimSurfaces) {
    test(`${label} lists the reconnect events and not BrokerDisconnected`, () => {
      const listed = enumeratedEvents(file, anchor);
      for (const published of PUBLISHED_ON_A_REFUSED_CONNECT) {
        expect(listed).toContain(published);
      }
      for (const absent of ABSENT_ON_A_REFUSED_CONNECT) {
        expect(listed).not.toContain(absent);
      }
    });
  }
});
