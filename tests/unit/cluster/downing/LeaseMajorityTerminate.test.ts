/**
 * #1753 — a node that terminates without leaving still gives back what its
 * downing provider holds.
 *
 * Both leave routes call the provider's `shutdown()` (#1454), but
 * `ActorSystem.terminate()` on its own does not leave: with the shipped
 * `coordinated-shutdown.run-by-actor-system-terminate = false` it runs no
 * pipeline, so nothing called `Cluster.leave()`, and the cluster registered no
 * termination prelude of its own.  A lease-majority winner therefore went on
 * renewing its lease after a bare `terminate()`, the members it left behind
 * found the record taken at their next even split, and the renewal timer kept
 * the process alive.
 *
 * `Cluster.join` now registers a prelude that shuts the provider down, and the
 * cluster calls the provider's hook at most once whichever of a leave and a
 * terminate gets there first.  The first case is the end-to-end property, in a
 * child process whose exit is the assertion; the rest pin the hook from the
 * cluster's side with a counting provider.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import type { DowningDecision, DowningProvider } from '../../../../src/cluster/downing/DowningProvider.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

const SYSTEM = 'lease-terminate';

/**
 * A provider that counts its `decide()` and `shutdown()` calls, in order.  Its
 * `shutdown()` takes `releaseMs` to settle, as a release that has to reach a
 * backend does: a failure-detector tick still armed meanwhile would decide
 * again.
 */
class CountingProvider implements DowningProvider {
  readonly calls: Array<'decide' | 'shutdown'> = [];

  constructor(private readonly releaseMs = 0) {}

  decide(): DowningDecision {
    this.calls.push('decide');
    return new Set();
  }

  async shutdown(): Promise<void> {
    this.calls.push('shutdown');
    // Stands in for the round trip of a release; see the class comment.
    if (this.releaseMs > 0) await sleep(this.releaseMs);
  }

  get shutdowns(): number {
    return this.calls.filter((call) => call === 'shutdown').length;
  }

  get decisionsAfterShutdown(): number {
    const first = this.calls.indexOf('shutdown');
    return first < 0 ? 0 : this.calls.slice(first).filter((call) => call === 'decide').length;
  }
}

let systems: ActorSystem[] = [];

afterEach(async () => {
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
  systems = [];
});

async function startNode(port: number, downing: DowningProvider): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 20, unreachableAfterMs: 200, downAfterMs: 4_000 })
    .withSplitBrainResolver({ stableAfterMs: 1 })
    .withGossipIntervalMs(60_000)
    .withDowning(downing);
  return { system, cluster: await Cluster.join(system, clusterOptions) };
}

describe('a bare terminate gives back what the downing provider holds (#1753)', () => {
  test('the process the winner terminated in, without leaving, releases the lease and exits', () => {
    const fixture = join(import.meta.dir, 'LeaseMajorityTerminate.fixture.ts');
    const child = spawnSync(process.execPath, ['run', fixture], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      // Generous against a loaded runner; the fixture's own work takes a second
      // or two, so a run that reaches this limit is the held process.
      timeout: 15_000,
    });
    expect(child.stdout, `the fixture never reached its arbitration:\n${child.stderr}`).toContain('won=true');
    expect(child.stdout, 'the terminate did not free the record').toContain('released=true');
    expect(child.signal, 'the fixture had to be killed — something kept its event loop alive').toBeNull();
    expect(child.status).toBe(0);
  }, 25_000);

  test('a bare terminate calls the provider\'s hook once, and nothing asks it to decide afterwards', async () => {
    // Ten detector ticks long, so a tick the prelude left armed would decide again.
    const provider = new CountingProvider(200);
    const node = await startNode(64_771, provider);
    await awaitCondition(() => provider.calls.includes('decide'), {
      timeoutMs: 2_000, label: 'the failure-detector tick asked the provider',
    });

    await node.system.terminate();
    // An absence, so a fixed wait: five detector ticks in which one still armed would decide again.
    await sleep(100);

    expect(provider.shutdowns).toBe(1);
    expect(provider.decisionsAfterShutdown).toBe(0);
  });

  test('a leave followed by a terminate still calls it exactly once', async () => {
    const provider = new CountingProvider();
    const node = await startNode(64_781, provider);

    await node.cluster.leave();
    await node.system.terminate();

    expect(provider.shutdowns).toBe(1);
  });
});
