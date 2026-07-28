import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Props } from '../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ActorTreeTap } from '../../../src/devtools/taps/ActorTreeTap.js';
import { MailboxSamplerTap } from '../../../src/devtools/taps/MailboxSamplerTap.js';
import { StatsTap } from '../../../src/devtools/taps/StatsTap.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
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
      system.spawn(Props.create(() => new IdleActor()), 'watched');
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
      const ref = system.spawn(Props.create(() => new IdleActor()), 'doomed');
      await settle();
      system.stop(ref);
      await settle();

      const stopped = emitted.filter((p): p is ActorStoppedPayload => p.kind === 'actor-stopped');
      expect(stopped.some((p) => p.path.endsWith('/doomed'))).toBe(true);
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

    system.spawn(Props.create(() => new IdleActor()), 'after-uninstall');
    await settle();
    expect(emitted.filter((p) => p.kind === 'actor-started')
      .some((p) => (p as ActorStartedPayload).actor.name === 'after-uninstall')).toBe(false);
  });
});

describe('MailboxSamplerTap', () => {
  test('reports a backlogged actor and hides the idle majority', async () => {
    const system = newSystem('tap-mailbox');
    const tap = new MailboxSamplerTap(system, 20, 10);
    tap.install(() => {});
    try {
      const ref = system.spawn(Props.create(() => new SlowActor()), 'slow');
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
    const tap = new StatsTap(system, null, 1_000);
    tap.install(() => {});
    try {
      const first = (tap.snapshot() as [StatsSamplePayload])[0];
      const before = first.actorsStarted;

      const ref = system.spawn(Props.create(() => new IdleActor()), 'counted');
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
    const tap = new StatsTap(system, null, 1_000);
    tap.install(() => {});
    try {
      const ref = system.spawn(Props.create(() => new SlowActor()), 'busy');
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
    const tap = new StatsTap(system, null, 1_000);
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
    const tap = new StatsTap(system, null, 1_000);
    tap.install(() => {});
    try {
      const ref = system.spawn(Props.create(() => new IdleActor()), 'gone');
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
    const tap = new StatsTap(system, null, 1_000);
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

  test('switches metrics on while attached and hands them back on detach', async () => {
    const system = newSystem('tap-stats-metrics');
    const metrics = system.extension(MetricsExtensionId);
    expect(metrics.isEnabled()).toBe(false);

    const tap = new StatsTap(system, null, 1_000);
    tap.install(() => {});
    expect(metrics.isEnabled()).toBe(true);

    const ref = system.spawn(Props.create(() => new IdleActor()), 'chatty');
    for (let i = 0; i < 4; i++) ref.tell(`m${i}`);
    await settle();

    const [sample] = tap.snapshot() as [StatsSamplePayload];
    expect(sample.messagesProcessed).toBeGreaterThanOrEqual(4);
    expect(sample.mailboxDrops).toBe(0);
    expect(sample.handlerLatency?.count).toBeGreaterThanOrEqual(4);

    tap.uninstall();
    expect(metrics.isEnabled()).toBe(false);
  });

  test('leaves a registry the application enabled itself alone', () => {
    const system = newSystem('tap-stats-metrics-preowned');
    const metrics = system.extension(MetricsExtensionId);
    const registry = metrics.enable();

    const tap = new StatsTap(system, null, 1_000);
    tap.install(() => {});
    tap.uninstall();

    expect(metrics.isEnabled()).toBe(true);
    expect(metrics.get()).toBe(registry);
  });

  test('reports stash depth and suspended actors', async () => {
    const system = newSystem('tap-stats-stash');
    const tap = new StatsTap(system, null, 1_000);
    tap.install(() => {});
    try {
      const ref = system.spawn(Props.create(() => new StashingActor()), 'hoarder');
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
