/**
 * Cross-node MDC propagation (#53).  Tells crossing the cluster wire
 * carry the originating node's `LogContext` so the receiving actor —
 * on a different process / node — sees the same correlationId,
 * userId, etc.
 *
 *   - Originating tell on node A in `LogContext.run({correlationId:
 *     'abc'}, ...)`.
 *   - Receiver actor lives on node B.  When its `onReceive` runs,
 *     `LogContext.get()` returns the same object.
 *   - Tells from inside the receiver (e.g. the receiver replies via
 *     `sender.tell`) carry the context onward; we exercise that by
 *     having B reply to a probe on C.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { RemoteActorRef } from '../../src/cluster/RemoteActorRef.js';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { LogContext } from '../../src/LogContext.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(25);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Node {
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
}

async function startNode(systemName: string, port: number, seeds: string[]): Promise<Node> {
  const sys = ActorSystem.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(sys, {
    host: 'h', port, seeds,
    transport: new InMemoryTransport(new NodeAddress(systemName, 'h', port)),
    gossipIntervalMs: 30,
  });
  return { sys, cluster };
}

async function stop(n: Node): Promise<void> {
  try { await n.cluster.leave(); } catch { /* */ }
  await n.sys.terminate();
}

describe('LogContext — cross-node propagation', () => {
  test('a tell from node A to a remote actor on node B carries the correlationId', async () => {
    const observed: Array<Record<string, unknown>> = [];
    class Echo extends Actor<{ payload: string; replyTo: ActorRef<string> }> {
      override onReceive(m: { payload: string; replyTo: ActorRef<string> }): void {
        observed.push({ ...LogContext.get() });
        m.replyTo.tell(`got:${m.payload}`);
      }
    }
    class Probe extends Actor<string> {
      readonly received: string[] = [];
      readonly seen: Array<Record<string, unknown>> = [];
      override onReceive(m: string): void {
        this.received.push(m);
        this.seen.push({ ...LogContext.get() });
      }
    }

    const sysName = 'mdc-xnode';
    const a = await startNode(sysName, 60_001, []);
    const b = await startNode(sysName, 60_002, [`${sysName}@h:60001`]);
    try {
      await waitFor(() => a.cluster.upMembers().length === 2);

      // Echo lives on B.  Probe lives on A.
      b.sys.spawn(Props.create(() => new Echo()), 'echo');
      const probeActor = new Probe();
      const probeRef = a.sys.spawn(Props.create(() => probeActor), 'probe');

      // Build a RemoteActorRef from A pointing at /user/echo on B.
      // ActorSelection won't help here — it resolves only locally.
      const echoOnB = new RemoteActorRef<{ payload: string; replyTo: ActorRef<string> }>(
        b.cluster.selfAddress,
        `actor-ts://${sysName}/user/echo`,
        a.cluster,
      );

      LogContext.run({ correlationId: 'cross-1', region: 'eu' }, () => {
        echoOnB.tell({ payload: 'hello', replyTo: probeRef });
      });

      await waitFor(() => observed.length > 0 && probeActor.received.length > 0, 5_000);
      // Echo on B observed the originating context.
      expect(observed[0]).toEqual({ correlationId: 'cross-1', region: 'eu' });
      // Probe on A observed the SAME context — the reply travelled back
      // with the context still attached because Echo's tell snapshotted
      // the freshly-installed run() scope.
      expect(probeActor.seen[0]).toEqual({ correlationId: 'cross-1', region: 'eu' });
      expect(probeActor.received[0]).toBe('got:hello');
    } finally {
      await stop(a);
      await stop(b);
    }
  }, 15_000);

  test('without a run() scope, cross-node tells carry no context', async () => {
    const observed: Array<Record<string, unknown>> = [];
    class Echo extends Actor<string> {
      override onReceive(_m: string): void { observed.push({ ...LogContext.get() }); }
    }

    const sysName = 'mdc-xnode-empty';
    const a = await startNode(sysName, 60_011, []);
    const b = await startNode(sysName, 60_012, [`${sysName}@h:60011`]);
    try {
      await waitFor(() => a.cluster.upMembers().length === 2);
      b.sys.spawn(Props.create(() => new Echo()), 'echo');
      const echoOnB = new RemoteActorRef<string>(
        b.cluster.selfAddress,
        `actor-ts://${sysName}/user/echo`,
        a.cluster,
      );

      // No run() — tell goes through with empty context.
      echoOnB.tell('plain');

      await waitFor(() => observed.length > 0, 5_000);
      expect(observed[0]).toEqual({});
    } finally {
      await stop(a);
      await stop(b);
    }
  }, 15_000);
});
