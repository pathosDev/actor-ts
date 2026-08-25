import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { ActorSystem } from '../../../../../src/ActorSystem.js';
import type { Config } from '../../../../../src/config/Config.js';
import { BrokerActor } from '../../../../../src/io/broker/BrokerActor.js';
import type { BrokerCommonOptionsType } from '../../../../../src/io/broker/BrokerOptions.js';
import { Terminated } from '../../../../../src/SystemMessages.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';

/**
 * `BrokerActor.onReceive` is sealed: it intercepts `Terminated`, prunes the dead
 * subscriber, and hands the subclass a command union that never contains the
 * signal (#709).
 *
 * The subclass under test is deliberately the one the issue is titled after —
 * an `onCommand` that is a bare `match(command).…exhaustive()` over its own two
 * kinds, with no `Terminated` arm anywhere and no `onTerminated` override.  Give
 * `onReceive` back to it and the very first subscriber death throws
 * `NonExhaustiveError`, which the default supervisor answers with a restart:
 * `preRestart` → `postStop` tears the transport down and `postRestart` →
 * `preStart` reconnects, so `connects` climbs and the prune never happens.  That
 * is what binds these assertions to the seal rather than to the doc recipe the
 * previous round shipped.
 */

type FanOutCommand = {
  readonly kind: 'fan-out';
  readonly topic: string;
  readonly payload: string;
};
type SubscribeCommand = {
  readonly kind: 'subscribe';
  readonly topic: string;
  readonly subscriber: ActorRef<unknown>;
};
type SealedCommand = FanOutCommand | SubscribeCommand;

interface SealedOptions extends BrokerCommonOptionsType {
  readonly endpoint?: string;
}

/**
 * Counters are **static**: a restart replaces the instance, so an instance
 * field could not tell "never restarted" from "restarted, and the fresh
 * instance has not counted yet" — which is exactly the distinction under test.
 */
class SealedBroker extends BrokerActor<SealedOptions, SealedCommand, string, string> {
  static connects = 0;
  /** Every command that reached `onCommand` — a `Terminated` here is the defect. */
  static seen: unknown[] = [];
  /** Signals the base handed on, with the topic count it saw at that moment. */
  static terminatedWith: number[] = [];

  static reset(): void {
    SealedBroker.connects = 0;
    SealedBroker.seen = [];
    SealedBroker.terminatedWith = [];
  }

  /** `BrokerActor`'s own constructor is protected — a test needs a public one. */
  constructor(options: Partial<SealedOptions> = {}) { super(options); }

  protected configKey(): string { return 'actor-ts.io.broker.sealed'; }
  protected builtInDefaultOptions(): Partial<SealedOptions> { return { endpoint: 'sealed:1' }; }
  protected readOptionsFromConfig(_config: Config): Partial<SealedOptions> { return {}; }
  protected requiredOptions(): ReadonlyArray<keyof SealedOptions> { return ['endpoint']; }
  protected endpointLabel(): string { return this.options.endpoint ?? '<none>'; }

  protected async connectImplementation(): Promise<void> { SealedBroker.connects++; }
  protected async disconnectImplementation(): Promise<void> { /* nothing to close */ }
  protected async dispatchOutgoing(): Promise<void> { /* never sends */ }

  /* The published recipe, verbatim: the subclass's own union and nothing else. */
  protected override onCommand(command: SealedCommand): void {
    SealedBroker.seen.push(command);
    match(command)
      .with({ kind: 'subscribe' }, (c) => this.onSubscribe(c))
      .with({ kind: 'fan-out' }, (c) => this.onFanOut(c))
      .exhaustive();
  }

  private onSubscribe(command: SubscribeCommand): void {
    this.subscribeRef(command.topic, command.subscriber);
  }

  private onFanOut(command: FanOutCommand): void {
    this.fanOutToTopic(command.topic, command.payload);
  }

  publicSubscriberCount(topic: string): number { return this.subscriberCountForTopic(topic); }
  publicConnectionState(): string { return this.connectionState; }
}

/**
 * Same base, but it takes the optional hook — the seam `MqttActor` needs for
 * the delivery targets it watches itself.  Recording the topic count *from
 * inside* the hook is what pins the ordering: the base prunes first, so a
 * subclass never observes a registry that still holds the dead ref.
 */
class HookBroker extends SealedBroker {
  protected override onTerminated(signal: Terminated): void {
    HookBroker.terminatedWith.push(this.subscriberCountForTopic('a'));
    // The base already dropped it; asking again must find nothing left.
    HookBroker.seen.push(`prune-again:${this.pruneTerminatedSubscriber(signal.actor)}`);
  }
}

class ProbeActor extends Actor<unknown> {
  received: unknown[] = [];
  override onReceive(message: unknown): void { this.received.push(message); }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function spawnBroker<B extends SealedBroker>(
  system: ActorSystem,
  make: () => B,
): { ref: ActorRef<SealedCommand>; ready: Promise<B> } {
  let resolve!: (broker: B) => void;
  const ready = new Promise<B>((r) => { resolve = r; });
  const ref = system.spawnAnonymous(() => {
    const broker = make();
    resolve(broker);
    return broker as unknown as Actor<SealedCommand>;
  }) as ActorRef<SealedCommand>;
  return { ref, ready };
}

function newSystem(name: string): ActorSystem {
  const system = createTestActorSystem({ name });
  systems.push(system);
  return system;
}

describe('BrokerActor — sealed dispatch (#709)', () => {
  test('a subscriber death is pruned without the subclass handling anything', async () => {
    SealedBroker.reset();
    const system = newSystem('sealed-dispatch');
    const { ref, ready } = spawnBroker(system, () => new SealedBroker());
    const broker = await ready;
    await awaitCondition(() => SealedBroker.connects === 1, { label: 'the broker connected' });

    const doomed = new ProbeActor();
    const doomedRef = system.spawnAnonymous(() => doomed as unknown as Actor<unknown>);
    const survivor = new ProbeActor();
    const survivorRef = system.spawnAnonymous(() => survivor as unknown as Actor<unknown>);
    ref.tell({ kind: 'subscribe', topic: 'a', subscriber: doomedRef });
    ref.tell({ kind: 'subscribe', topic: 'b', subscriber: doomedRef });
    ref.tell({ kind: 'subscribe', topic: 'a', subscriber: survivorRef });
    await awaitCondition(() => broker.publicSubscriberCount('a') === 2, {
      label: 'both subscribers registered on topic a',
    });

    doomedRef.stop();
    await awaitCondition(() => broker.publicSubscriberCount('a') === 1, {
      label: 'the base class pruned the stopped subscriber',
    });
    // Every topic it held, not just the one that still has a subscriber.
    expect(broker.publicSubscriberCount('b')).toBe(0);

    // The availability half: no `NonExhaustiveError`, so no supervisor restart,
    // so no reconnect.  `connectImplementation` would run a second time on the
    // restart path, and `postStop` would have torn the transport down first.
    expect(SealedBroker.connects).toBe(1);
    expect(broker.publicConnectionState()).toBe('connected');

    // And the signal never reached the subclass's matcher.
    expect(SealedBroker.seen.some((command) => command instanceof Terminated)).toBe(false);

    // The bridge still works, on the same instance.
    ref.tell({ kind: 'fan-out', topic: 'a', payload: 'after' });
    ref.tell({ kind: 'fan-out', topic: 'b', payload: 'after' });
    await awaitCondition(() => survivor.received.length >= 1, {
      label: 'the fan-out after the prune reached the survivor',
    });
    // The dead subscriber staying empty is an absence; it only means something
    // once the survivor's message has arrived and a moment has passed.
    await sleep(20);
    expect(survivor.received).toEqual(['after']);
    expect(doomed.received).toEqual([]);
  });

  test('the onTerminated hook still fires, and runs after the prune', async () => {
    SealedBroker.reset();
    const system = newSystem('sealed-dispatch-hook');
    const { ref, ready } = spawnBroker(system, () => new HookBroker());
    const broker = await ready;
    await awaitCondition(() => SealedBroker.connects === 1, { label: 'the broker connected' });

    const doomed = new ProbeActor();
    const doomedRef = system.spawnAnonymous(() => doomed as unknown as Actor<unknown>);
    ref.tell({ kind: 'subscribe', topic: 'a', subscriber: doomedRef });
    await awaitCondition(() => broker.publicSubscriberCount('a') === 1, {
      label: 'the subscriber registered',
    });

    doomedRef.stop();
    await awaitCondition(() => SealedBroker.terminatedWith.length === 1, {
      label: 'the subclass hook saw the Terminated',
    });
    // Zero, not one: the base pruned before handing the signal on.
    expect(SealedBroker.terminatedWith).toEqual([0]);
    expect(SealedBroker.seen).toContain('prune-again:false');
    expect(SealedBroker.connects).toBe(1);
  });
});
