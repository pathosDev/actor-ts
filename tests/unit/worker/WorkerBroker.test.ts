/**
 * WorkerBroker tests — the broker is the main-thread routing layer
 * between workers in a multi-core cluster.  Each worker hosts its own
 * MessagePort; the broker forwards `BrokeredMessage` envelopes by
 * looking up `to` in its registry.  We exercise registration,
 * unregistration, message routing, and close semantics against the
 * `FakePort` shim — no real worker spawned.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { Clock } from '../../../src/Clock.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { BrokeredMessage } from '../../../src/cluster/transports/MessageChannelTransport.js';
import { WORKER_BROKER_DROP_REPORT_INTERVAL_MS } from '../../../src/worker/Constants.js';
import { WorkerBroker } from '../../../src/worker/WorkerBroker.js';
import { NoopLogger } from '../../../src/Logger.js';
import { hostileEnvelopes } from '../../util/HostileFrames.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';
import { ThrowingLogger } from '../../util/ThrowingLogger.js';
import { FakePort } from './__fixtures__/InMemoryWorkerThread.js';

const addr = (port: number): NodeAddress => new NodeAddress('sys', 'host', port);

function envelope(from: NodeAddress, to: NodeAddress): BrokeredMessage {
  return {
    from: from.toJSON(),
    to: to.toJSON(),
    payload: { kind: 'ping' } as unknown as BrokeredMessage['payload'],
  };
}

describe('WorkerBroker — register / unregister', () => {
  test('register hooks the port and starts it', () => {
    const broker = new WorkerBroker();
    const port = new FakePort();
    broker.register(addr(1), port);
    expect(port.onmessage).toBeTypeOf('function');
    expect(port.started).toBe(true);
  });

  test('duplicate register throws', () => {
    const broker = new WorkerBroker();
    const address = addr(1);
    broker.register(address, new FakePort());
    expect(() => broker.register(address, new FakePort()))
      .toThrow(/already registered/);
  });

  test('unregister closes the port and clears the slot', () => {
    const broker = new WorkerBroker();
    const address = addr(1);
    const port = new FakePort();
    broker.register(address, port);
    broker.unregister(address);
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();
    // After unregister: registered() should no longer include it.
    expect(broker.registered().map(x => x.toString())).not.toContain(address.toString());
  });

  test('unregister of unknown address is a no-op', () => {
    const broker = new WorkerBroker();
    expect(() => broker.unregister(addr(99))).not.toThrow();
  });

  test('registered() returns a snapshot of NodeAddress values', () => {
    const broker = new WorkerBroker();
    broker.register(addr(1), new FakePort());
    broker.register(addr(2), new FakePort());
    broker.register(addr(3), new FakePort());
    const out = broker.registered().map(address => address.toString()).sort();
    expect(out).toEqual(['sys@host:1', 'sys@host:2', 'sys@host:3']);
  });
});

describe('WorkerBroker — routing', () => {
  test('forwards messages to the registered destination port', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    // Inject a message into aPort destined for addr(2).
    const env = envelope(addr(1), addr(2));
    aPort.inject(env);

    // Routed to bPort verbatim.
    expect(bPort.posted).toEqual([env]);
    // aPort doesn't receive its own message.
    expect(aPort.posted).toEqual([]);
  });

  test('drops messages destined for unknown addresses silently', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    broker.register(addr(1), aPort);

    aPort.inject(envelope(addr(1), addr(999)));
    // Nothing crashed; the unknown destination has nowhere to forward
    // to.  The other workers (only addr(1) here) see nothing either.
    expect(aPort.posted).toEqual([]);
  });

  test('after close(), further messages are dropped', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    broker.close();

    aPort.inject(envelope(addr(1), addr(2)));
    expect(aPort.closed).toBe(true);
    expect(bPort.closed).toBe(true);
    expect(bPort.posted).toEqual([]);
  });

  test('close() empties the registry', () => {
    const broker = new WorkerBroker();
    broker.register(addr(1), new FakePort());
    broker.register(addr(2), new FakePort());
    broker.close();
    expect(broker.registered()).toEqual([]);
  });

  test('register after close() is refused and does not repopulate the registry', () => {
    const broker = new WorkerBroker();
    broker.register(addr(1), new FakePort());
    broker.close();

    // A respawn that lost the race with shutdown.  Without the guard the port
    // is retained for the process lifetime while `onMessage` drops all of its
    // traffic — inert, and holding its worker alive (#735).
    const late = new FakePort();
    broker.register(addr(2), late);
    expect(broker.registered()).toEqual([]);
    expect(late.onmessage).toBeNull();
    expect(late.started).toBe(false);
    expect(late.closed).toBe(true);
  });

  test('messages route correctly across more than two workers', () => {
    const broker = new WorkerBroker();
    const p1 = new FakePort();
    const p2 = new FakePort();
    const p3 = new FakePort();
    broker.register(addr(1), p1);
    broker.register(addr(2), p2);
    broker.register(addr(3), p3);

    p1.inject(envelope(addr(1), addr(3)));
    p2.inject(envelope(addr(2), addr(1)));

    expect(p3.posted.length).toBe(1);
    expect((p3.posted[0] as BrokeredMessage).from.port).toBe(1);
    expect(p1.posted.length).toBe(1);
    expect((p1.posted[0] as BrokeredMessage).from.port).toBe(2);
    expect(p2.posted).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* #701 — a malformed frame must not reach `NodeAddress.fromJSON`            */
/* ------------------------------------------------------------------------ */

describe('WorkerBroker — malformed frames', () => {
  /**
   * Every case in {@link hostileEnvelopes} used to throw out of `onMessage`,
   * i.e. out of the host's worker `message` listener, where nothing catches it:
   * Node re-raises it as an `uncaughtException` and Bun exits 1.  One frame
   * from one worker took the whole process down.
   *
   * The table lives in `tests/util/HostileFrames.ts` because three suites need
   * exactly it — this one, the testkit broker fork's, and the transport
   * contract test #945 added — and the two that had it inline said so in a
   * comment while the third had no malformed case at all.
   */
  for (const [label, frame] of hostileEnvelopes) {
    test(`drops a frame with ${label} instead of throwing`, () => {
      // The drop is the subject, its report is not (#1276 covers that below);
      // the default sink would put a WARN per row on stderr of a green run.
      const broker = new WorkerBroker(new NoopLogger());
      const aPort = new FakePort();
      const bPort = new FakePort();
      broker.register(addr(1), aPort);
      broker.register(addr(2), bPort);

      expect(() => aPort.inject(frame)).not.toThrow();
      expect(bPort.posted).toEqual([]);
      expect(aPort.posted).toEqual([]);
    });
  }

  /**
   * The second half of the pair, and the reason both halves need naming.
   *
   * `onMessage` has two defences over one another — the envelope guard and the
   * `try`/`catch` behind it — and every case in the corpus above used to be
   * absorbed by whichever one was left, so each could be deleted on its own
   * with this file staying green.  The `from.port` row now covers the guard;
   * this covers the backstop, with the one thing the guard cannot pre-empt: a
   * destination port that throws when the frame is handed to it.
   *
   * That is not a hypothetical shape.  `PortLike` is a pluggable interface with
   * in-process implementations — the testkit's broker fork, and the manual mesh
   * `worker-mesh.mdx` wires end to end — whose `postMessage` runs the far side
   * synchronously, so a throw over there comes back out through this call.  A
   * real `MessagePort` contributes its own: `postMessage` raises `DataCloneError`
   * on a payload it cannot clone.  Either way there is no caller to unwind
   * into — this is the host thread's `message` listener — so an escaping throw
   * is an uncaught top-level error, exactly the shape #701 is about, reached by
   * a route the guard does not stand on.
   */
  test('a destination port that throws does not take the broker down with it', () => {
    const broker = new WorkerBroker(new NoopLogger());
    const aPort = new FakePort();
    const cPort = new FakePort();
    const exploding = new FakePort();
    exploding.postMessage = (): void => { throw new Error('DataCloneError'); };
    broker.register(addr(1), aPort);
    broker.register(addr(2), exploding);
    broker.register(addr(3), cPort);

    expect(() => aPort.inject(envelope(addr(1), addr(2)))).not.toThrow();

    // And the broker is still a broker afterwards: one bad port must not cost
    // every other worker its routing.
    const good = envelope(addr(1), addr(3));
    aPort.inject(good);
    expect(cPort.posted).toEqual([good]);
  });

  test('a hostile frame does not stop the next well-formed one from routing', () => {
    const broker = new WorkerBroker(new NoopLogger());
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    aPort.inject({ from: addr(1).toJSON(), to: null });
    const good = envelope(addr(1), addr(2));
    aPort.inject(good);

    expect(bPort.posted).toEqual([good]);
  });
});

/* ------------------------------------------------------------------------ */
/* #774 — `from` names the port the frame arrived on, not what it claims     */
/* ------------------------------------------------------------------------ */

describe('WorkerBroker — sender identity comes from the channel', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  `onMessage` took the registration key
   * as `_sourceKey`, marked it unused, and re-posted the frame verbatim.  The
   * receiving `MessageChannelTransport` builds its peer identity from
   * `env.from` and hands it to `Cluster.handleWire`, so a worker that wrote a
   * sibling's address into `from` refreshed that sibling's failure-detector
   * timer at every other node — a dead worker kept looking alive, blocking
   * singleton and shard failover — and had its envelopes attributed to the
   * sibling for reply routing and every `maySpeakFor` rule.  This is the
   * worker-mesh counterpart of `tests/multi-node/ClusterSecurity.test.ts`'s
   * "a heartbeat is credited to the connection, not to the address it names".
   */
  test('a forged `from` is rewritten to the sending port\'s registered address', () => {
    const broker = new WorkerBroker();
    const p1 = new FakePort();
    const p2 = new FakePort();
    const p3 = new FakePort();
    broker.register(addr(1), p1);
    broker.register(addr(2), p2);
    broker.register(addr(3), p3);

    // p1 is registered as addr(1) and claims to be addr(2).
    p1.inject(envelope(addr(2), addr(3)));

    expect(p3.posted.length).toBe(1);
    expect((p3.posted[0] as BrokeredMessage).from.port).toBe(1);
    // The impersonated worker learns nothing about the attempt either.
    expect(p2.posted).toEqual([]);
  });

  /**
   * The other half of the pair: a guard that rewrote every frame, or dropped
   * every frame, would satisfy the test above and be useless.  `toBe` and not
   * `toEqual` — an honest frame must come out as the *same object*, which is
   * what says the equality fast path took it rather than a rebuilt copy that
   * merely compares equal.
   */
  test('an honest frame is forwarded verbatim, not rebuilt', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    const honest = envelope(addr(1), addr(2));
    aPort.inject(honest);

    expect(bPort.posted.length).toBe(1);
    expect(bPort.posted[0]).toBe(honest);
  });

  test('a `from` naming an address nobody registered is corrected too', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    aPort.inject(envelope(addr(999), addr(2)));

    expect(bPort.posted.length).toBe(1);
    expect((bPort.posted[0] as BrokeredMessage).from.port).toBe(1);
  });

  /**
   * Pins the boundary the fix deliberately stops at.  `toString`, `equals` and
   * `compareTo` all exclude the incarnation, so the slot is the identity every
   * consumer keys on and the slot is what gets corrected; the incarnation
   * stays the sender's own claim while #940 keeps it carried-but-not-acted-on.
   * When a merge rule first keys on it, this test is the one that has to
   * change — deliberately, in that commit.
   */
  test('an incarnation on an otherwise-honest `from` is passed through (#940)', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    const claimed = new NodeAddress('sys', 'host', 1, 'a-claimed-incarnation');
    aPort.inject(envelope(claimed, addr(2)));

    expect(bPort.posted.length).toBe(1);
    expect((bPort.posted[0] as BrokeredMessage).from.incarnation)
      .toBe('a-claimed-incarnation');
  });

  test('a forged frame for an unknown destination is still dropped', () => {
    const broker = new WorkerBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    aPort.inject(envelope(addr(2), addr(999)));

    expect(aPort.posted).toEqual([]);
    expect(bPort.posted).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* #1276 — a drop is counted, and reported as one folded line per reason    */
/* ------------------------------------------------------------------------ */

describe('WorkerBroker — drops are counted and reported (#1276)', () => {
  /** A clock the test moves by hand, so the fold can be crossed without a thirty-second wait. */
  class ManualClock implements Clock {
    nowMs = 0;
    now(): number { return this.nowMs; }
  }

  const NO_DROPS = { malformed: 0, 'unknown-destination': 0, unroutable: 0 };
  const messagesAt = (logger: RecordingLogger, level: string): string[] =>
    logger.records.filter((record) => record.level === level).map((record) => record.message);

  test('a fresh broker has dropped nothing, and the snapshot is a copy', () => {
    const broker = new WorkerBroker(new RecordingLogger());
    const snapshot = broker.dropped();
    expect(snapshot).toEqual(NO_DROPS);
    (snapshot as { malformed: number }).malformed = 99;
    expect(broker.dropped()).toEqual(NO_DROPS);
  });

  test('malformed frames are tallied, and fold into one WARN per interval carrying the count', () => {
    const logger = new RecordingLogger();
    const clock = new ManualClock();
    const broker = new WorkerBroker(logger, clock);
    const aPort = new FakePort();
    broker.register(addr(1), aPort);

    // Three hostile frames inside one interval: the first is reported at once,
    // the next two are folded and counted only.
    for (const [, frame] of hostileEnvelopes.slice(0, 3)) aPort.inject(frame);
    expect(broker.dropped().malformed).toBe(3);
    expect(messagesAt(logger, 'warn')).toEqual([
      '[worker] broker dropped 1 frame(s), most recently from sys@host:1 — the envelope is not a BrokeredMessage — '
      + 'its address fields failed the shape check, and nothing past them was read',
    ]);
    expect(messagesAt(logger, 'debug')).toEqual([]);

    // Past the interval the next drop flushes the fold: the two suppressed
    // frames plus the one that triggered the line.
    clock.nowMs += WORKER_BROKER_DROP_REPORT_INTERVAL_MS;
    aPort.inject(hostileEnvelopes[3]![1]);
    expect(broker.dropped().malformed).toBe(4);
    const warnings = messagesAt(logger, 'warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/^\[worker\] broker dropped 3 frame\(s\), most recently from sys@host:1 — /);

    // One short of the interval is still inside it.
    clock.nowMs += WORKER_BROKER_DROP_REPORT_INTERVAL_MS - 1;
    aPort.inject(hostileEnvelopes[4]![1]);
    expect(broker.dropped().malformed).toBe(5);
    expect(messagesAt(logger, 'warn')).toHaveLength(2);
  });

  test('the fold is keyed on the reason, never on the source port', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    aPort.inject('not-an-envelope');
    bPort.inject('not-an-envelope');
    // A second source inside the interval buys no second line: a per-source
    // throttle is the map a misbehaving worker grows.
    expect(messagesAt(logger, 'warn')).toHaveLength(1);
    expect(broker.dropped().malformed).toBe(2);
  });

  test('a well-formed frame to an address nobody registered is counted, and reported at debug', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    broker.register(addr(1), aPort);

    aPort.inject(envelope(addr(1), addr(999)));

    expect(broker.dropped()['unknown-destination']).toBe(1);
    expect(messagesAt(logger, 'warn')).toEqual([]);
    expect(messagesAt(logger, 'debug')).toEqual([
      '[worker] broker dropped 1 frame(s), most recently from sys@host:1 — no worker is registered at the destination '
      + 'address — expected briefly after a worker dies, while its siblings\' gossip catches up with the '
      + 'failure detector',
    ]);
    expect(aPort.posted).toEqual([]);
  });

  test('a destination port that throws is counted as unroutable and reported with the port\'s error', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    const cPort = new FakePort();
    const exploding = new FakePort();
    // The shape a real `MessagePort` throws — a `DOMException` whose *name* is
    // `DataCloneError`; the line quotes the name, never the message.
    exploding.postMessage = (): void => { throw new DOMException('The object can not be cloned.', 'DataCloneError'); };
    broker.register(addr(1), aPort);
    broker.register(addr(2), exploding);
    broker.register(addr(3), cPort);

    expect(() => aPort.inject(envelope(addr(1), addr(2)))).not.toThrow();

    expect(broker.dropped()).toEqual({ ...NO_DROPS, unroutable: 1 });
    expect(messagesAt(logger, 'warn')).toEqual([
      '[worker] broker dropped 1 frame(s), most recently from sys@host:1 — the destination port refused the frame: DataCloneError',
    ]);
    // Still a broker afterwards, and the honest hop is not a drop.
    const good = envelope(addr(1), addr(3));
    aPort.inject(good);
    expect(cPort.posted).toEqual([good]);
    expect(broker.dropped()).toEqual({ ...NO_DROPS, unroutable: 1 });
  });

  test('each reason keeps its own fold — a drop of one kind does not silence the first of another', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    broker.register(addr(1), aPort);

    aPort.inject('not-an-envelope');
    aPort.inject(envelope(addr(1), addr(999)));

    expect(broker.dropped()).toEqual({ ...NO_DROPS, malformed: 1, 'unknown-destination': 1 });
    expect(messagesAt(logger, 'warn')).toHaveLength(1);
    expect(messagesAt(logger, 'debug')).toHaveLength(1);
  });

  test('a frame that arrives after close() is neither counted nor reported — shutdown is not a drop', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    broker.register(addr(1), aPort);
    // The handler `register` installed, captured before `close()` nulls it —
    // the only way a frame can still reach `onMessage` once the broker has
    // stopped, which is the backstop this test is about.
    const handler = aPort.onmessage!;
    broker.close();

    aPort.inject('not-an-envelope');
    handler({ data: 'not-an-envelope' });
    handler({ data: envelope(addr(1), addr(999)) });

    expect(broker.dropped()).toEqual(NO_DROPS);
    expect(logger.records).toEqual([]);
  });

  test('no line ever carries anything lifted from the frame', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    const exploding = new FakePort();
    exploding.postMessage = (): void => { throw new Error('the port refused it'); };
    broker.register(addr(1), aPort);
    broker.register(addr(2), exploding);
    const marker = 'NEVER-IN-A-LOG-LINE';

    // Malformed, with the marker in the payload and in what stands in for `to`.
    aPort.inject({ from: addr(1).toJSON(), to: marker, payload: { kind: marker } });
    // Unknown destination, with the marker as the address the sender chose.
    aPort.inject({
      from: addr(1).toJSON(),
      to: { systemName: marker, host: marker, port: 999 },
      payload: { kind: marker },
    });
    // Unroutable, with the marker in the payload the port refused.
    aPort.inject({ ...envelope(addr(1), addr(2)), payload: { kind: marker } as unknown as BrokeredMessage['payload'] });

    expect(broker.dropped()).toEqual({ malformed: 1, 'unknown-destination': 1, unroutable: 1 });
    expect(logger.records).toHaveLength(3);
    for (const record of logger.records) {
      expect(record.message).not.toContain(marker);
      // The one identity the line does carry is the host-minted source.
      expect(record.message).toContain('most recently from sys@host:1');
    }
  });

  test('a broker built without a logger reports through the console — the same default sink the pool has', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const broker = new WorkerBroker();
      const aPort = new FakePort();
      broker.register(addr(1), aPort);

      aPort.inject('not-an-envelope');
      aPort.inject(envelope(addr(1), addr(999)));

      const warned = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(warned.filter((line) => line.includes('[worker] broker dropped 1 frame(s), most recently from sys@host:1 — the envelope is not a BrokeredMessage'))).toHaveLength(1);
      // `ConsoleLogger` at `Info` hides the debug line, which is the point of
      // that level for the reason that bursts after every crash.
      expect(debugSpy.mock.calls).toEqual([]);
      expect(broker.dropped()).toEqual({ ...NO_DROPS, malformed: 1, 'unknown-destination': 1 });
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  /**
   * The fold covers every port since the reason last reached the log, but the
   * line used to say `from <source>` with the port that happened to trigger
   * the flush — so three malformed frames from worker 1 and one from worker 2
   * read as "dropped 3 frame(s) from sys@host:2", and an operator went looking
   * at the wrong worker.  `EnvelopeTrust.report` says `most recently from` for
   * exactly this reason; the broker's line now does too.
   */
  test('the folded line attributes the count to no single port — it names the most recent source', () => {
    const logger = new RecordingLogger();
    const clock = new ManualClock();
    const broker = new WorkerBroker(logger, clock);
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(addr(1), aPort);
    broker.register(addr(2), bPort);

    // Three from worker 1 inside one interval: one line, two folded.
    for (let i = 0; i < 3; i++) aPort.inject('not-an-envelope');
    // Past the interval, one from worker 2 flushes the fold.  The line covers
    // three drops, of which worker 2 sent exactly one.
    clock.nowMs += WORKER_BROKER_DROP_REPORT_INTERVAL_MS;
    bPort.inject('not-an-envelope');

    const warnings = messagesAt(logger, 'warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/^\[worker\] broker dropped 3 frame\(s\), most recently from sys@host:2 — /);
    expect(warnings[1]).not.toMatch(/frame\(s\) from sys@host:2/);
    expect(broker.dropped().malformed).toBe(4);
  });

  /**
   * The report runs inside the port's `onmessage` callback — the host's
   * worker `message` listener, where nothing above the broker catches — and
   * `Logger` is a caller-supplied extension point.  A sink that throws used
   * to take the callback down with it: the same host-killing shape #701
   * closed for a malformed frame, reopened by the line that reports one.
   * The drop is still counted, and the line lands on the console with the
   * reason it had to.
   */
  test('a logger that throws cannot escape the port callback — the line falls back to the console', () => {
    const logger = new ThrowingLogger('the log sink is down');
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    broker.register(addr(1), aPort);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => aPort.inject('not-an-envelope')).not.toThrow();
      expect(() => aPort.inject(envelope(addr(1), addr(999)))).not.toThrow();

      expect(logger.calls).toBe(2);
      expect(broker.dropped()).toEqual({ ...NO_DROPS, malformed: 1, 'unknown-destination': 1 });
      const fallback = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(fallback).toHaveLength(2);
      expect(fallback[0]).toMatch(/^\[worker\] broker dropped 1 frame\(s\), most recently from sys@host:1 — the envelope is not a BrokeredMessage/);
      expect(fallback[0]).toMatch(/logger threw while reporting this: the log sink is down\)$/);
      expect(fallback[1]).toMatch(/no worker is registered at the destination address/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  /**
   * The `unroutable` detail is rendered inside the catch handler around
   * `postMessage`, so the rendering itself has to be unable to throw.
   * `String(error)` is not: a null-prototype throwable has no `toString`,
   * and the `TypeError` it raised escaped the callback the catch exists to
   * protect.
   */
  test('a port that throws a null-prototype value is contained and described by its type', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    const hostile = new FakePort();
    hostile.postMessage = (): void => { throw Object.create(null); };
    broker.register(addr(1), aPort);
    broker.register(addr(2), hostile);

    expect(() => aPort.inject(envelope(addr(1), addr(2)))).not.toThrow();

    expect(broker.dropped()).toEqual({ ...NO_DROPS, unroutable: 1 });
    expect(messagesAt(logger, 'warn')).toEqual([
      '[worker] broker dropped 1 frame(s), most recently from sys@host:1 — the destination port refused the frame: '
      + 'a non-Error object',
    ]);
  });

  /**
   * On Node 26.7 a `DataCloneError`'s message echoes the value it could not
   * clone — `() => 'SECRET-IN-SOURCE' could not be cloned.` — which is frame
   * content by another route, on a line specified never to carry any.  Only
   * the error's *name* is the runtime's own vocabulary, and only it reaches
   * the line.
   */
  test('the unroutable detail carries the error\'s name and never its message', () => {
    const logger = new RecordingLogger();
    const broker = new WorkerBroker(logger, new ManualClock());
    const aPort = new FakePort();
    const refusing = new FakePort();
    refusing.postMessage = (): void => {
      throw new DOMException("() => 'SECRET-IN-SOURCE' could not be cloned.", 'DataCloneError');
    };
    broker.register(addr(1), aPort);
    broker.register(addr(2), refusing);

    aPort.inject(envelope(addr(1), addr(2)));

    const warnings = messagesAt(logger, 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/refused the frame: DataCloneError$/);
    expect(warnings[0]).not.toContain('SECRET-IN-SOURCE');
    expect(warnings[0]).not.toContain('could not be cloned');
  });
});
