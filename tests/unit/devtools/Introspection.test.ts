import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Props } from '../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  ActorLifecycleEvent,
  ActorRestarted,
  ActorStarted,
  ActorStopped,
} from '../../../src/SystemMessages.js';
import { Directive, OneForOneStrategy } from '../../../src/Supervision.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import type { CellInspection } from '../../../src/internal/Instrumentation.js';

class LeafActor extends Actor<string> {
  override onReceive(message: string): void {
    if (message === 'boom') throw new Error('leaf exploded');
  }
}

class ParentActor extends Actor<string> {
  override preStart(): void {
    this.context.spawn(Props.create(() => new LeafActor()), 'leaf');
  }
  override supervisorStrategy(): OneForOneStrategy {
    return new OneForOneStrategy(() => Directive.Restart, { maxRetries: 3, withinTimeRangeMs: 1_000 });
  }
  override onReceive(message: string): void {
    if (message === 'break-child') this.context.children[0]?.tell('boom' as never);
  }
}

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, options);
}

/** Collect lifecycle events through a probe actor on the event stream. */
function lifecycleProbe(system: ActorSystem): {
  events: ActorLifecycleEvent[];
  ref: ActorRef;
} {
  const events: ActorLifecycleEvent[] = [];
  class ProbeActor extends Actor<ActorLifecycleEvent> {
    override onReceive(event: ActorLifecycleEvent): void {
      events.push(event);
    }
  }
  const ref = system.spawn(Props.create(() => new ProbeActor()), 'lifecycle-probe');
  system.eventStream.subscribe(ref, ActorLifecycleEvent);
  return { events, ref };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

describe('actor lifecycle events', () => {
  test('a started actor is announced with its class and parent', async () => {
    const system = newSystem('lifecycle-start');
    try {
      const { events } = lifecycleProbe(system);
      system.spawn(Props.create(() => new LeafActor()), 'solo');
      await settle();

      const started = events.filter((e): e is ActorStarted => e instanceof ActorStarted);
      const solo = started.find((e) => e.actor.path.name === 'solo');
      expect(solo).toBeDefined();
      expect(solo!.className).toBe('LeafActor');
      expect(solo!.parentPath).toContain('/user');
    } finally {
      await system.terminate();
    }
  });

  test('a stopped actor is announced', async () => {
    const system = newSystem('lifecycle-stop');
    try {
      const { events } = lifecycleProbe(system);
      const ref = system.spawn(Props.create(() => new LeafActor()), 'transient');
      await settle();
      system.stop(ref);
      await settle();

      const stopped = events.filter((e): e is ActorStopped => e instanceof ActorStopped);
      expect(stopped.some((e) => e.actor.path.name === 'transient')).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('a supervisor restart is announced with its cause', async () => {
    const system = newSystem('lifecycle-restart');
    try {
      const { events } = lifecycleProbe(system);
      const parent = system.spawn(Props.create(() => new ParentActor()), 'parent');
      await settle();
      parent.tell('break-child');
      await settle();

      const restarted = events.filter((e): e is ActorRestarted => e instanceof ActorRestarted);
      expect(restarted.length).toBeGreaterThan(0);
      expect(restarted[0]!.actor.path.name).toBe('leaf');
      expect(restarted[0]!.cause.message).toContain('leaf exploded');
    } finally {
      await system.terminate();
    }
  });

  test('subscribing to one variant does not deliver the others', async () => {
    const system = newSystem('lifecycle-filter');
    try {
      const seen: ActorStopped[] = [];
      class StopOnlyActor extends Actor<ActorStopped> {
        override onReceive(event: ActorStopped): void { seen.push(event); }
      }
      const ref = system.spawn(Props.create(() => new StopOnlyActor()), 'stop-probe');
      system.eventStream.subscribe(ref, ActorStopped);

      const victim = system.spawn(Props.create(() => new LeafActor()), 'victim');
      await settle();
      // Several starts have happened by now; none of them may arrive here.
      expect(seen).toHaveLength(0);

      system.stop(victim);
      await settle();
      expect(seen.some((e) => e.actor.path.name === 'victim')).toBe(true);
    } finally {
      await system.terminate();
    }
  });
});

describe('ActorSystem._inspectTree', () => {
  const byName = (tree: ReadonlyArray<CellInspection>, name: string): CellInspection | undefined =>
    tree.find((cell) => cell.name === name);

  test('returns the guardians of a fresh system', () => {
    const system = newSystem('tree-guardians');
    try {
      const tree = system._inspectTree();
      expect(byName(tree, 'user')).toBeDefined();
      expect(byName(tree, 'system')).toBeDefined();
      // The root guardian carries the empty name and has no parent.
      expect(tree[0]!.parentPath).toBeNull();
    } finally {
      void system.terminate();
    }
  });

  test('lists parents before their children', async () => {
    const system = newSystem('tree-order');
    try {
      system.spawn(Props.create(() => new ParentActor()), 'parent');
      await settle();

      const tree = system._inspectTree();
      const parentIndex = tree.findIndex((cell) => cell.name === 'parent');
      const leafIndex = tree.findIndex((cell) => cell.name === 'leaf');
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(leafIndex).toBeGreaterThan(parentIndex);
      expect(tree[leafIndex]!.parentPath).toBe(tree[parentIndex]!.path);
    } finally {
      await system.terminate();
    }
  });

  test('describes an actor with the fields a debugger renders', async () => {
    const system = newSystem('tree-fields');
    try {
      system.spawn(Props.create(() => new ParentActor()), 'parent');
      await settle();

      const parent = byName(system._inspectTree(), 'parent')!;
      expect(parent.className).toBe('ParentActor');
      // Nothing custom: the path is already right there in `path`.
      expect(parent.displayName).toBeNull();
      expect(parent.cellState).toBe('running');
      expect(parent.childCount).toBe(1);
      expect(parent.mailboxSize).toBe(0);
      expect(parent.stashSize).toBe(0);
      expect(parent.suspended).toBe(false);
      expect(parent.path).toContain('/user/parent');
    } finally {
      await system.terminate();
    }
  });

  test('drops an actor from the tree once it has stopped', async () => {
    const system = newSystem('tree-shrink');
    try {
      const ref = system.spawn(Props.create(() => new LeafActor()), 'ephemeral');
      await settle();
      expect(byName(system._inspectTree(), 'ephemeral')).toBeDefined();

      system.stop(ref);
      await settle();
      expect(byName(system._inspectTree(), 'ephemeral')).toBeUndefined();
    } finally {
      await system.terminate();
    }
  });

  test('reports a backlog on an actor that is not draining', async () => {
    const system = newSystem('tree-backlog');
    try {
      class BlockedActor extends Actor<string> {
        override async onReceive(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const ref = system.spawn(Props.create(() => new BlockedActor()), 'blocked');
      for (let i = 0; i < 5; i++) ref.tell(`m${i}`);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const blocked = byName(system._inspectTree(), 'blocked')!;
      expect(blocked.mailboxSize).toBeGreaterThan(0);
    } finally {
      await system.terminate();
    }
  });
});
