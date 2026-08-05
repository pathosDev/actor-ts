import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ActorTreeTap } from '../../../src/devtools/taps/ActorTreeTap.js';
import { MailboxSamplerTap } from '../../../src/devtools/taps/MailboxSamplerTap.js';
import { StatsTap } from '../../../src/devtools/taps/StatsTap.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { NodeSampler } from '../../../src/devtools/internal/NodeSampler.js';
import type {
  ActorStartedPayload,
  ActorStoppedPayload,
  ActorTreeSnapshotPayload,
  DevToolsStreamPayload,
  MailboxSamplePayload,
  StatsSamplePayload,
} from '../../../src/devtools/protocol/index.js';

class IdleActor extends Actor<string> {
  override onReceive(): void {}
}

class SlowActor extends Actor<string> {
  override async onReceive(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Never unstashes — the stash depth is the point. */
class StashingActor extends Actor<string> {
  override onReceive(): void {
    this.context.stash();
  }
}

/** Names itself, and renames on every message — the display-name path (#891). */
class NamedActor extends Actor<string> {
  private label = 'first';
  override displayName(): string { return this.label; }
  override onReceive(message: string): void { this.label = message; }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The sampler a `DevToolsServer` would own.  Shared with the cluster
 * node agent in real use, so the tap takes one rather than making it.
 */
const samplers: NodeSampler[] = [];
afterEach(() => {
  for (const sampler of samplers.splice(0)) sampler.stop();
});
function startedSampler(system: ActorSystem): NodeSampler {
  const sampler = new NodeSampler(system);
  sampler.start();
  samplers.push(sampler);
  return sampler;
}

describe('ActorTreeTap', () => {
  test('snapshots the whole tree', () => {
    const system = newSystem('tap-tree-snapshot');
    const tap = new ActorTreeTap(system);
    tap.install(() => {});
    try {
      const [payload] = tap.snapshot() as [ActorTreeSnapshotPayload];
      expect(payload.kind).toBe('actor-tree-snapshot');
      expect(payload.actors.some((actor) => actor.name === 'user')).toBe(true);
    } finally {
      tap.uninstall();
    }
  });

  test('emits a delta when an actor starts, carrying live figures', async () => {
    const system = newSystem('tap-tree-start');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new ActorTreeTap(system);
    tap.install((payload) => emitted.push(payload));
    try {
      system.spawn(IdleActor, 'watched');
      await settle();

      const started = emitted.filter((p): p is ActorStartedPayload => p.kind === 'actor-started');
      const watched = started.find((p) => p.actor.name === 'watched');
      expect(watched).toBeDefined();
      expect(watched!.actor.className).toBe('IdleActor');
      expect(watched!.actor.cellState).toBe('running');
      expect(watched!.actor.parentPath).toContain('/user');
    } finally {
      tap.uninstall();
    }
  });

  test('emits a delta when an actor stops', async () => {
    const system = newSystem('tap-tree-stop');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new ActorTreeTap(system);
    tap.install((payload) => emitted.push(payload));
    try {
      const ref = system.spawn(IdleActor, 'doomed');
      await settle();
      system.stop(ref);
      await settle();

      const stopped = emitted.filter((p): p is ActorStoppedPayload => p.kind === 'actor-stopped');
      expect(stopped.some((p) => p.path.endsWith('/doomed'))).toBe(true);
    } finally {
      tap.uninstall();
    }
  });

  test('carries the display name, and null when the actor never named itself', async () => {
    const system = newSystem('tap-tree-display-name');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new ActorTreeTap(system);
    tap.install((payload) => emitted.push(payload));
    try {
      system.spawn(IdleActor, 'anonymous');
      system.spawn(IdleActor, 'from-options', ActorOptions.create().withDisplayName('cart'));
      system.spawn(NamedActor, 'from-method');
      await settle();

      const started = emitted.filter((p): p is ActorStartedPayload => p.kind === 'actor-started');
      const spawned = (name: string) => started.find((p) => p.actor.name === name)!.actor;
      expect(spawned('anonymous').displayName).toBeNull();
      expect(spawned('from-options').displayName).toBe('cart');
      expect(spawned('from-method').displayName).toBe('first');
      // A label, never a replacement for the key the panel indexes on.
      expect(spawned('from-options').path).toContain('/from-options');
    } finally {
      tap.uninstall();
    }
  });

  test('stops emitting once uninstalled', async () => {
    const system = newSystem('tap-tree-uninstall');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new ActorTreeTap(system);
    tap.install((payload) => emitted.push(payload));
    tap.uninstall();

    system.spawn(IdleActor, 'after-uninstall');
    await settle();
    expect(emitted.filter((p) => p.kind === 'actor-started')
      .some((p) => (p as ActorStartedPayload).actor.name === 'after-uninstall')).toBe(false);
  });
});

describe('ActorTreeTap — live state', () => {
  test('reports a cell whose state moved after it started', async () => {
    const system = newSystem('tap-tree-changed');
    const tap = new ActorTreeTap(system, 20);
    const payloads: DevToolsStreamPayload[] = [];
    tap.install((payload) => payloads.push(payload));
    try {
      const ref = system.spawn(StashingActor, 'hoarder');
      // Let the actor finish starting first: `actor-started` re-inspects,
      // so anything that happens before it lands is already in that frame
      // and would not prove the ticker did anything.
      await settle();
      tap.snapshot();          // seeds the baseline, as a subscription does
      tap.subscribersChanged(1);
      for (let i = 0; i < 3; i++) ref.tell(`m${i}`);
      await settle(120);

      const changed = payloads.filter((p) => p.kind === 'actor-changed');
      const hoarder = changed.find((p) => p.actor.path.endsWith('/hoarder'));
      expect(hoarder).toBeDefined();
      expect(hoarder!.actor.stashSize).toBe(3);
    } finally {
      tap.uninstall();
    }
  });

  test('re-emits when only the display name moved', async () => {
    const system = newSystem('tap-tree-renamed');
    const tap = new ActorTreeTap(system, 20);
    const payloads: DevToolsStreamPayload[] = [];
    tap.install((payload) => payloads.push(payload));
    try {
      const ref = system.spawn(NamedActor, 'renamer');
      await settle();
      tap.snapshot();
      tap.subscribersChanged(1);
      payloads.length = 0;

      // Handling this leaves every other field exactly where it was, so
      // the delta can only come from the name comparison in `hasMoved`.
      ref.tell('second');
      await settle(120);

      const changed = payloads.filter((p) => p.kind === 'actor-changed');
      const renamer = changed.find((p) => p.actor.path.endsWith('/renamer'));
      expect(renamer).toBeDefined();
      expect(renamer!.actor.displayName).toBe('second');
    } finally {
      tap.uninstall();
    }
  });

  test('a quiet tick says nothing, and no subscriber means no tick', async () => {
    const system = newSystem('tap-tree-quiet');
    const tap = new ActorTreeTap(system, 20);
    const payloads: DevToolsStreamPayload[] = [];
    tap.install((payload) => payloads.push(payload));
    try {
      system.spawn(IdleActor, 'still');
      await settle();
      tap.snapshot();
      payloads.length = 0;

      // Nobody is watching yet.
      await settle(100);
      expect(payloads).toHaveLength(0);

      // Watching, but nothing is happening.
      tap.subscribersChanged(1);
      await settle(100);
      expect(payloads.filter((p) => p.kind === 'actor-changed')).toHaveLength(0);

      tap.subscribersChanged(0);
    } finally {
      tap.uninstall();
    }
  });
});

describe('MailboxSamplerTap', () => {
  test('reports a backlogged actor and hides the idle majority', async () => {
    const system = newSystem('tap-mailbox');
    const tap = new MailboxSamplerTap(system, 20, 10);
    tap.install(() => {});
    try {
      const ref = system.spawn(SlowActor, 'slow');
      for (let i = 0; i < 4; i++) ref.tell(`m${i}`);
      await settle(20);

      const [sample] = tap.snapshot() as [MailboxSamplePayload];
      expect(sample.kind).toBe('mailbox-sample');
      expect(sample.sampled).toBeGreaterThan(sample.entries.length);
      expect(sample.entries.some((entry) => entry.path.endsWith('/slow'))).toBe(true);
      // Idle actors (the guardians) must not pad the list.
      expect(sample.entries.every((entry) => entry.size > 0 || entry.stashSize > 0 || entry.suspended))
        .toBe(true);
    } finally {
      tap.uninstall();
    }
  });

  test('only ticks while someone is subscribed', async () => {
    const system = newSystem('tap-mailbox-idle');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new MailboxSamplerTap(system, 15, 10);
    tap.install((payload) => emitted.push(payload));
    try {
      await settle(60);
      expect(emitted).toHaveLength(0);

      tap.subscribersChanged(1);
      await settle(60);
      const whileWatched = emitted.length;
      expect(whileWatched).toBeGreaterThan(0);

      tap.subscribersChanged(0);
      await settle(60);
      expect(emitted.length).toBe(whileWatched);
    } finally {
      tap.uninstall();
    }
  });
});

describe('StatsTap', () => {
  test('counts lifecycle events cumulatively from attach', async () => {
    const system = newSystem('tap-stats');
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const first = (tap.snapshot() as [StatsSamplePayload])[0];
      const before = first.actorsStarted;

      const ref = system.spawn(IdleActor, 'counted');
      await settle();
      const afterStart = (tap.snapshot() as [StatsSamplePayload])[0];
      expect(afterStart.actorsStarted).toBeGreaterThan(before);
      expect(afterStart.actorsStopped).toBe(0);

      system.stop(ref);
      await settle();
      const afterStop = (tap.snapshot() as [StatsSamplePayload])[0];
      expect(afterStop.actorsStopped).toBeGreaterThan(0);
      // Cumulative, never reset.
      expect(afterStop.actorsStarted).toBeGreaterThanOrEqual(afterStart.actorsStarted);
    } finally {
      tap.uninstall();
    }
  });

  test('reports the runtime, actor count and mailbox backlog', async () => {
    const system = newSystem('tap-stats-shape');
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const ref = system.spawn(SlowActor, 'busy');
      for (let i = 0; i < 3; i++) ref.tell(`m${i}`);
      await settle(20);

      const [sample] = tap.snapshot() as [StatsSamplePayload];
      expect(['bun', 'node', 'deno']).toContain(sample.runtime);
      expect(sample.actorCount).toBeGreaterThan(0);
      expect(sample.mailboxBacklog).toBeGreaterThan(0);
      expect(sample.topMailboxes[0]!.path).toContain('busy');
      expect(sample.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      tap.uninstall();
    }
  });

  test('omits the cluster block on a system with no cluster', () => {
    const system = newSystem('tap-stats-nocluster');
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const [sample] = tap.snapshot() as [StatsSamplePayload];
      expect(sample.cluster).toBeUndefined();
    } finally {
      tap.uninstall();
    }
  });

  test('counts dead letters', async () => {
    const system = newSystem('tap-stats-deadletters');
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const ref = system.spawn(IdleActor, 'gone');
      system.stop(ref);
      await settle();
      ref.tell('into the void');
      await settle();

      const [sample] = tap.snapshot() as [StatsSamplePayload];
      expect(sample.deadLetters).toBeGreaterThan(0);
    } finally {
      tap.uninstall();
    }
  });

  test('measures uptime from system start, not from attach', async () => {
    const system = newSystem('tap-stats-uptime');
    await settle(40);
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const [sample] = tap.snapshot() as [StatsSamplePayload];
      // The system predates the tap, so uptime must already exceed the
      // gap — measuring from attach would report roughly zero.
      expect(sample.uptimeMs).toBeGreaterThanOrEqual(35);
      expect(sample.uptimeMs).toBeLessThanOrEqual(Date.now() - system.startedAtMs + 5);
    } finally {
      tap.uninstall();
    }
  });

  test('reads throughput, drops and latency off the framework counters', async () => {
    const system = newSystem('tap-stats-metrics');
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const ref = system.spawn(IdleActor, 'chatty');
      for (let i = 0; i < 4; i++) ref.tell(`m${i}`);
      await settle();

      const [sample] = tap.snapshot() as [StatsSamplePayload];
      expect(sample.messagesProcessed).toBeGreaterThanOrEqual(4);
      expect(sample.mailboxDrops).toBe(0);
      expect(sample.handlerLatency?.count).toBeGreaterThanOrEqual(4);
    } finally {
      tap.uninstall();
    }
  });

  test('every sample carries the per-node breakdown, cluster or not', async () => {
    const system = newSystem('tap-stats-nodes');
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const [sample] = tap.snapshot() as [StatsSamplePayload];
      // One node, but the same shape a cluster produces — so the panel
      // has one way to render "total and per node", not two.
      expect(sample.nodes).toHaveLength(1);
      expect(sample.nodes[0]!.isSelf).toBe(true);
      expect(sample.nodes[0]!.stale).toBe(false);
      expect(sample.nodes[0]!.figures.address).toBe('local');
      expect(sample.nodes[0]!.figures.systemName).toBe('tap-stats-nodes');
      // The totals are the sum of the breakdown, not a second count.
      expect(sample.actorCount).toBe(sample.nodes[0]!.figures.actorCount);
    } finally {
      tap.uninstall();
    }
  });

  test('reports stash depth and suspended actors', async () => {
    const system = newSystem('tap-stats-stash');
    const tap = new StatsTap(system, null, 1_000, startedSampler(system));
    tap.install(() => {});
    try {
      const ref = system.spawn(StashingActor, 'hoarder');
      for (let i = 0; i < 3; i++) ref.tell(`m${i}`);
      await settle();

      const [sample] = tap.snapshot() as [StatsSamplePayload];
      expect(sample.stashedTotal).toBe(3);
      expect(sample.suspendedActors).toBe(0);
    } finally {
      tap.uninstall();
    }
  });
});
