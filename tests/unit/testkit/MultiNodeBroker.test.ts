/**
 * `MultiNodeBroker` — the testkit's fork of `WorkerBroker`, routing the worker
 * mesh behind `ParallelMultiNodeSpec` and adding the two hooks a harness needs
 * that production does not: `partition` / `heal`, and dropping frames from a
 * port whose address has been unregistered.
 *
 * Until #701's second pass this file had **no** suite at all, and that absence
 * is why it kept the unguarded `fromJSON(env.to)` shape for the whole of the
 * first fix.  The only suite that exercises it indirectly —
 * `tests/unit/testkit/ParallelMultiNodeSpec.test.ts` — is one of the three
 * quarantined behind `ACTOR_TS_SKIP_FLAKY_MNS`, so a regression there is
 * invisible to CI.  Everything here drives the broker through the `FakePort`
 * shim instead: no worker is spawned, so this suite runs everywhere, on every
 * push.
 *
 * The shim is the same `FakePort` `tests/unit/worker/WorkerBroker.test.ts`
 * uses, and the malformed-frame corpus is now literally the same array —
 * `tests/util/HostileFrames.ts`, which #945 extracted once the transport on the
 * far side of these ports needed it too.  Both brokers clear one shared guard
 * (`isBrokeredMessage`), so what is being pinned here is not a second
 * implementation but the fact that this fork still calls it.
 */
import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../../../src/cluster/transports/MessageChannelTransport.js';
import { MultiNodeBroker } from '../../../src/testkit/internal/MultiNodeBroker.js';
import { hostileEnvelopes } from '../../util/HostileFrames.js';
import { FakePort } from '../worker/__fixtures__/InMemoryWorkerThread.js';

const nodeAddress = (port: number): NodeAddress => new NodeAddress('sys', 'host', port);

function envelope(from: NodeAddress, to: NodeAddress): BrokeredMessage {
  return {
    from: from.toJSON(),
    to: to.toJSON(),
    payload: { kind: 'ping' } as unknown as BrokeredMessage['payload'],
  };
}

/**
 * The port of a worker that `crash()` has already terminated.  `postMessage`
 * throws rather than returning, which is what the runtime adapters do —
 * `WebWorkerBackend` surfaces it as `InvalidStateError: Worker has been
 * terminated`.
 */
class TerminatedPort implements PortLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;

  postMessage(): void {
    throw new Error('InvalidStateError: Worker has been terminated');
  }

  close(): void { this.onmessage = null; }
  start(): void { /* a terminated port has nothing to start */ }
}

describe('MultiNodeBroker — register / unregister', () => {
  test('register hooks the port and starts it', () => {
    const broker = new MultiNodeBroker();
    const port = new FakePort();
    broker.register(nodeAddress(1), port);
    expect(port.onmessage).toBeTypeOf('function');
    expect(port.started).toBe(true);
  });

  test('duplicate register throws', () => {
    const broker = new MultiNodeBroker();
    const address = nodeAddress(1);
    broker.register(address, new FakePort());
    expect(() => broker.register(address, new FakePort())).toThrow(/already registered/);
  });

  test('registered() returns a snapshot of NodeAddress values', () => {
    const broker = new MultiNodeBroker();
    broker.register(nodeAddress(1), new FakePort());
    broker.register(nodeAddress(2), new FakePort());
    const out = broker.registered().map((address) => address.toString()).sort();
    expect(out).toEqual(['sys@host:1', 'sys@host:2']);
  });

  test('unregister closes the port and clears the slot', () => {
    const broker = new MultiNodeBroker();
    const address = nodeAddress(1);
    const port = new FakePort();
    broker.register(address, port);
    broker.unregister(address);
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();
    expect(broker.registered()).toEqual([]);
  });

  /**
   * The property `crash()` depends on: a frame already in flight when the
   * sending worker went away must not be delivered.  The handler is captured
   * before `unregister` nulls it, because that is exactly the ordering a
   * real in-flight frame has — the event was queued while the port was live.
   */
  test('a frame from an unregistered sender is dropped', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), bPort);

    const inFlight = aPort.onmessage;
    broker.unregister(nodeAddress(1));
    inFlight?.({ data: envelope(nodeAddress(1), nodeAddress(2)) });

    expect(bPort.posted).toEqual([]);
  });
});

describe('MultiNodeBroker — routing', () => {
  test('forwards a frame to the registered destination port', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), bPort);

    const frame = envelope(nodeAddress(1), nodeAddress(2));
    aPort.inject(frame);

    expect(bPort.posted).toEqual([frame]);
    expect(aPort.posted).toEqual([]);
  });

  test('drops a frame destined for an unknown address', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    broker.register(nodeAddress(1), aPort);

    expect(() => aPort.inject(envelope(nodeAddress(1), nodeAddress(999)))).not.toThrow();
    expect(aPort.posted).toEqual([]);
  });

  test('after close() every port is closed and further frames are dropped', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), bPort);

    const inFlight = aPort.onmessage;
    broker.close();
    inFlight?.({ data: envelope(nodeAddress(1), nodeAddress(2)) });

    expect(aPort.closed).toBe(true);
    expect(bPort.closed).toBe(true);
    expect(bPort.posted).toEqual([]);
    expect(broker.registered()).toEqual([]);
  });
});

describe('MultiNodeBroker — partition / heal', () => {
  test('partition blocks both directions and heal restores them', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    const a = nodeAddress(1);
    const b = nodeAddress(2);
    broker.register(a, aPort);
    broker.register(b, bPort);

    broker.partition(a, b);
    aPort.inject(envelope(a, b));
    bPort.inject(envelope(b, a));
    expect(bPort.posted).toEqual([]);
    expect(aPort.posted).toEqual([]);

    broker.heal(a, b);
    const aToB = envelope(a, b);
    const bToA = envelope(b, a);
    aPort.inject(aToB);
    bPort.inject(bToA);
    expect(bPort.posted).toEqual([aToB]);
    expect(aPort.posted).toEqual([bToA]);
  });

  test('a partition between two peers leaves a third peer reachable', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    const cPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), bPort);
    broker.register(nodeAddress(3), cPort);

    broker.partition(nodeAddress(1), nodeAddress(2));
    const aToC = envelope(nodeAddress(1), nodeAddress(3));
    aPort.inject(envelope(nodeAddress(1), nodeAddress(2)));
    aPort.inject(aToC);

    expect(bPort.posted).toEqual([]);
    expect(cPort.posted).toEqual([aToC]);
  });
});

/* ------------------------------------------------------------------------ */
/* #774 — the fork must correct `from` the way production does               */
/* ------------------------------------------------------------------------ */

describe('MultiNodeBroker — sender identity comes from the channel', () => {
  /**
   * `withChannelSource` is imported from the production broker rather than
   * re-implemented, so the rule itself is pinned by
   * `tests/unit/worker/WorkerBroker.test.ts`.  What is pinned here is that the
   * fork still spends it: a harness that let a scenario forge `from` where
   * production rewrites it would pass scenarios that fail in a real mesh.
   */
  test('a forged `from` is rewritten to the sending port\'s registered address', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    const cPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), bPort);
    broker.register(nodeAddress(3), cPort);

    // aPort is registered as address 1 and claims to be address 2.
    aPort.inject(envelope(nodeAddress(2), nodeAddress(3)));

    expect(cPort.posted.length).toBe(1);
    expect((cPort.posted[0] as BrokeredMessage).from.port).toBe(1);
    expect(bPort.posted).toEqual([]);
  });

  test('an honest frame is forwarded verbatim, not rebuilt', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), bPort);

    const honest = envelope(nodeAddress(1), nodeAddress(2));
    aPort.inject(honest);

    expect(bPort.posted.length).toBe(1);
    expect(bPort.posted[0]).toBe(honest);
  });
});

/* ------------------------------------------------------------------------ */
/* #701 — a malformed frame must not reach `NodeAddress.fromJSON`            */
/* ------------------------------------------------------------------------ */

describe('MultiNodeBroker — malformed frames', () => {
  /**
   * The corpus `tests/unit/worker/WorkerBroker.test.ts` pins for production,
   * against the fork that kept the defect.  Every case used to throw out of
   * `onMessage` — i.e. out of the harness's own `message` listener, where
   * nothing catches it — so one bad frame from one worker failed the whole
   * test process rather than the scenario that sent it.
   *
   * It is now literally the same array — `tests/util/HostileFrames.ts` — rather
   * than a copy this file promised to keep in step by hand (#945).
   */
  for (const [label, frame] of hostileEnvelopes) {
    test(`drops a frame with ${label} instead of throwing`, () => {
      const broker = new MultiNodeBroker();
      const aPort = new FakePort();
      const bPort = new FakePort();
      broker.register(nodeAddress(1), aPort);
      broker.register(nodeAddress(2), bPort);

      expect(() => aPort.inject(frame)).not.toThrow();
      expect(bPort.posted).toEqual([]);
      expect(aPort.posted).toEqual([]);
    });
  }

  test('a hostile frame does not stop the next well-formed one from routing', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const bPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), bPort);

    aPort.inject({ from: nodeAddress(1).toJSON(), to: null });
    const good = envelope(nodeAddress(1), nodeAddress(2));
    aPort.inject(good);

    expect(bPort.posted).toEqual([good]);
  });

  /**
   * The try/catch backstop, driven by the one case that reaches it in practice:
   * `crash()` terminates a worker and a frame already addressed to it is
   * forwarded a beat later.  `docs/…/testing/diagnosing-flakes.mdx` records this
   * escaping as `InvalidStateError: Worker has been terminated`, attributed to
   * whichever test happened to be running.  A terminated peer is an unroutable
   * destination, and those have always been dropped here.
   */
  test('a destination port that throws on postMessage does not throw out of the broker', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const terminated = new TerminatedPort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), terminated);

    expect(() => aPort.inject(envelope(nodeAddress(1), nodeAddress(2)))).not.toThrow();
  });

  test('a throwing destination does not stop a later frame to a live peer', () => {
    const broker = new MultiNodeBroker();
    const aPort = new FakePort();
    const terminated = new TerminatedPort();
    const cPort = new FakePort();
    broker.register(nodeAddress(1), aPort);
    broker.register(nodeAddress(2), terminated);
    broker.register(nodeAddress(3), cPort);

    aPort.inject(envelope(nodeAddress(1), nodeAddress(2)));
    const good = envelope(nodeAddress(1), nodeAddress(3));
    aPort.inject(good);

    expect(cPort.posted).toEqual([good]);
  });
});
