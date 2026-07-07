/**
 * Worker-side scenario module for `tests/multi-node/parallel-pubsub.test.ts`.
 *
 * Loaded by the bootstrap inside each worker.  Sets up a
 * `DistributedPubSub` mediator and a TestProbe-like collector for
 * messages received on subscribed topics.  The harness drives the
 * scenario via the four commands defined below.
 */
import { DistributedPubSubId, DistributedPubSubOptions } from '../../../src/cluster/pubsub/index.js';
import {
  Publish, Subscribe,
} from '../../../src/cluster/pubsub/Messages.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import type {
  ScenarioContext,
  ScenarioModule,
} from '../../../src/testkit/internal/parallel-multi-node-bootstrap.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';
import { TestProbeOptions } from '../../../src/testkit/TestProbeOptions.js';

interface SubscribeArgs { readonly topic: string }
interface PublishArgs { readonly topic: string; readonly message: unknown }
interface DrainArgs { readonly topic: string }

interface ScenarioState {
  readonly mediator: ActorRef<unknown>;
  readonly probesByTopic: Map<string, TestProbe>;
}

function getState(ctx: ScenarioContext): ScenarioState {
  return ctx.state.scenario as ScenarioState;
}

export const setup: ScenarioModule['setup'] = async (ctx) => {
  const pubsub = ctx.system.extension(DistributedPubSubId);
  const pubsubOptions = DistributedPubSubOptions.create()
    .withGossipIntervalMs(100);
  const mediator = pubsub.start(ctx.cluster, pubsubOptions);
  ctx.state.scenario = {
    mediator,
    probesByTopic: new Map<string, TestProbe>(),
  } satisfies ScenarioState;
};

export const commands: ScenarioModule['commands'] = {
  /** Subscribe a fresh probe to `topic`.  Returns when the
   *  Subscribe message has been enqueued. */
  subscribe(args, ctx): void {
    const { topic } = args as SubscribeArgs;
    const state = getState(ctx);
    const probeOptions = TestProbeOptions.create()
      .withName(`probe-${topic}`);
    const probe = new TestProbe(ctx.system, probeOptions);
    state.probesByTopic.set(topic, probe);
    state.mediator.tell(new Subscribe(topic, probe) as never);
  },

  /** Publish a message on `topic`. */
  publish(args, ctx): void {
    const { topic, message } = args as PublishArgs;
    const state = getState(ctx);
    state.mediator.tell(new Publish(topic, message) as never);
  },

  /** Drain every received message from `topic`'s probe.  Returns the
   *  list of messages collected so far + clears the inbox. */
  async drain(args, ctx): Promise<unknown[]> {
    const { topic } = args as DrainArgs;
    const state = getState(ctx);
    const probe = state.probesByTopic.get(topic);
    if (!probe) return [];
    const out: unknown[] = [];
    while (probe.hasMessage()) {
      out.push(await probe.receiveOne(50));
    }
    return out;
  },

  /** How many messages are currently buffered for `topic`. */
  buffered(args, ctx): number {
    const { topic } = args as { topic: string };
    const state = getState(ctx);
    return state.probesByTopic.get(topic)?.messageCount ?? 0;
  },
};
