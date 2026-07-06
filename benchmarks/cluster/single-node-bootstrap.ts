/**
 * Single-node cluster bootstrap — how long does it take to join a
 * cluster of one (no seeds)?  Good lower-bound baseline.
 *
 *   bun run benchmarks/cluster/single-node-bootstrap.ts
 */
import {
  ActorSystem,
  ActorSystemOptions,
  Cluster,
  ClusterOptions,
  InMemoryTransport,
  LogLevel,
  NoopLogger,
  NodeAddress,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

let port = 40_000;

async function bootstrap(): Promise<void> {
  const p = port++;
  const sys = ActorSystem.create('bench', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const cluster = await Cluster.join(sys, ClusterOptions.create()
    .withHost('h')
    .withPort(p)
    .withTransport(new InMemoryTransport(new NodeAddress('bench', 'h', p)))
    .withGossipIntervalMs(50));
  await cluster.leave();
  await sys.terminate();
}

async function main(): Promise<void> {
  await runGroup('cluster · single-node bootstrap', [
    { name: 'join + leave', unit: 'bootstrap', iterations: 50, run: bootstrap },
  ]);
}

void main();
