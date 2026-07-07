/**
 * Cross-node distributed tracing (#10).  A tell that crosses the
 * cluster wire carries its parent span context as a W3C `traceparent`
 * header on the wire envelope.  The receiving node decodes it,
 * opens a `cluster.envelope.received` span as the network-hop
 * marker, and the inner `actor.receive` span links back to the
 * originating client span — producing one coherent trace across
 * the two-node hop.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { RemoteActorRef } from '../../src/cluster/RemoteActorRef.js';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { RecordingTracer } from '../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../src/tracing/TracingExtension.js';

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
  readonly tracer: RecordingTracer;
}

async function startNode(systemName: string, port: number, seeds: string[]): Promise<Node> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  const tracer = new RecordingTracer();
  sys.extension(TracingExtensionId).enable(tracer);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster, tracer };
}

async function stop(n: Node): Promise<void> {
  try { await n.cluster.leave(); } catch { /* */ }
  await n.sys.terminate();
}

describe('Distributed tracing — cross-node propagation', () => {
  test('A→B remote tell stitches into one trace via cluster.envelope.received', async () => {
    const sysName = 'tr-xnode';
    const a = await startNode(sysName, 65_001, []);
    const b = await startNode(sysName, 65_002, [`${sysName}@h:65001`]);
    try {
      await waitFor(() => a.cluster.upMembers().length === 2);

      class Echo extends Actor<string> {
        override onReceive(_m: string): void { /* span recorded automatically */ }
      }
      b.sys.spawn(Props.create(() => new Echo()), 'echo');
      const echoOnB = new RemoteActorRef<string>(
        b.cluster.selfAddress,
        `actor-ts://${sysName}/user/echo`,
        a.cluster,
      );

      const client = a.tracer.startSpan('client.work');
      a.tracer.withActiveSpan(client, () => echoOnB.tell('hello'));
      await sleep(80);
      client.end();

      // Spans recorded on A: client.work.
      const aSpans = a.tracer.recorded();
      const clientSpan = aSpans.find((s) => s.name === 'client.work');
      expect(clientSpan).toBeDefined();

      // Spans recorded on B: cluster.envelope.received + actor.receive.
      const bSpans = b.tracer.recorded();
      const wireSpan = bSpans.find((s) => s.name === 'cluster.envelope.received');
      const recvSpan = bSpans.find((s) => s.name === 'actor.receive');
      expect(wireSpan).toBeDefined();
      expect(recvSpan).toBeDefined();

      // All three share the same traceId.
      const traceId = clientSpan!.context.traceId;
      expect(wireSpan!.context.traceId).toBe(traceId);
      expect(recvSpan!.context.traceId).toBe(traceId);

      // Parent chain: client → wire → actor.receive.
      expect(wireSpan!.parent?.spanId).toBe(clientSpan!.context.spanId);
      expect(recvSpan!.parent?.spanId).toBe(wireSpan!.context.spanId);

      // The wire span exposes useful attributes.
      expect(wireSpan!.attributes['cluster.from']).toContain('h:65001');
      expect(wireSpan!.attributes['cluster.to.path']).toContain('/user/echo');
    } finally {
      await stop(a);
      await stop(b);
    }
  }, 15_000);

  test('without enabling the tracer on the receiver, the wire trace is dropped silently', async () => {
    const sysName = 'tr-xnode-noop';
    const a = await startNode(sysName, 65_011, []);
    // Node B intentionally has the noop tracer (default).
    const sysBOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sysB = ActorSystem.create(sysName, sysBOptions);
    const clusterBOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(65_012)
      .withSeeds([`${sysName}@h:65011`])
      .withTransport(new InMemoryTransport(new NodeAddress(sysName, 'h', 65_012)))
      .withGossipIntervalMs(30);
    const clusterB = await Cluster.join(sysB, clusterBOptions);
    try {
      await waitFor(() => a.cluster.upMembers().length === 2);

      class Echo extends Actor<string> {
        override onReceive(_m: string): void { /* */ }
      }
      sysB.spawn(Props.create(() => new Echo()), 'echo');
      const echoOnB = new RemoteActorRef<string>(
        clusterB.selfAddress,
        `actor-ts://${sysName}/user/echo`,
        a.cluster,
      );

      const client = a.tracer.startSpan('client');
      a.tracer.withActiveSpan(client, () => echoOnB.tell('x'));
      await sleep(60);
      client.end();

      // A still has its client span.
      expect(a.tracer.recorded().some((s) => s.name === 'client')).toBe(true);
      // No exceptions on B's path — the noop tracer just drops the
      // extracted context.  We can't assert "no spans on B" without
      // a recorder, but the absence of crashes confirms the
      // graceful-degradation path.
    } finally {
      await stop(a);
      await clusterB.leave();
      await sysB.terminate();
    }
  }, 15_000);
});
