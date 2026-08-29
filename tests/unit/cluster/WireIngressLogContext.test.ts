/**
 * The wire-ingress twin of #718: an inbound frame that carries no MDC must be
 * dispatched under a *cleared* context, not under whichever store happened to
 * be ambient in the socket callback that delivered it.
 *
 * `Cluster.onEnvelope` had the same `if (context) run(…) else dispatch()` shape
 * as `ActorCell.handleUserMessage`, and the `else` there is reachable for the
 * same reason: `TcpTransport.send` opens its outbound socket lazily, so the
 * socket — and every `onData` callback on it — is bound to the
 * `AsyncLocalStorage` store of whichever request first sent to that peer.  A
 * context-free frame arriving on it was then delivered under one of *our* own
 * earlier requests' correlation ids, and `dispatchEnvelope`'s `ref.tell(body)`
 * re-stamped that onto the local envelope, so it travelled onward.
 *
 * `InMemoryTransport` reproduces the mechanism without a socket: its `send`
 * hands the receiver's handler to `queueMicrotask`, which propagates the
 * sender's store exactly as `setImmediate` and a socket callback do.  Sending
 * the frame from inside a `LogContext.run` scope is therefore the same shape as
 * a socket opened inside one — and it is the whole shape, since after this
 * point the code under test is the real `handleWire` → `onEnvelope` →
 * `dispatchEnvelope` path.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogContext } from '../../../src/LogContext.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/** Records the context every delivery arrived under. */
class Recorder extends Actor<string> {
  constructor(private readonly observed: Array<Record<string, unknown>>) { super(); }

  override onReceive(_message: string): void {
    this.observed.push({ ...LogContext.get() });
  }
}

const address = (name: string, port: number): NodeAddress => new NodeAddress(name, 'h', port);

async function startNode(name: string, port: number): Promise<Cluster> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(address(name, port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

/** A bare transport that speaks the wire under its own identity. */
async function peer(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(address(name, port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

describe('cluster wire ingress and the MDC (#718)', () => {
  test('a frame with no context is delivered under a cleared one', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const receiver = await startNode('ingress-clear', 49_201);
    const recorder = receiver.system.spawn(() => new Recorder(observed), 'recorder');
    const sender = await peer('ingress-sender', 49_202);

    // The scope stands in for the request that opened the connection: whatever
    // store is current when the delivering async resource is created is the one
    // the inbound callback runs under.
    LogContext.run({ tenant: 'A', userId: 'alice' }, () => {
      sender.send(address('ingress-clear', 49_201), {
        kind: 'envelope',
        to: recorder.path.toString(),
        from: null,
        body: 'no-context-frame',
      });
    });

    await awaitCondition(() => observed.length === 1, {
      timeoutMs: 4_000,
      label: 'the context-free frame reached the local actor',
    });
    expect(observed).toEqual([{}]);
  });

  test('a frame that does carry a context still installs it', async () => {
    // The other half of the same branch: clearing must not have cost the
    // cross-node propagation the branch exists for (#53).
    const observed: Array<Record<string, unknown>> = [];
    const receiver = await startNode('ingress-keep', 49_211);
    const recorder = receiver.system.spawn(() => new Recorder(observed), 'recorder');
    const sender = await peer('ingress-keep-sender', 49_212);

    sender.send(address('ingress-keep', 49_211), {
      kind: 'envelope',
      to: recorder.path.toString(),
      from: null,
      body: 'with-context-frame',
      context: { tenant: 'B', requestId: 'r-7' },
    });

    await awaitCondition(() => observed.length === 1, {
      timeoutMs: 4_000,
      label: 'the frame carrying a context reached the local actor',
    });
    expect(observed).toEqual([{ tenant: 'B', requestId: 'r-7' }]);
  });
});
