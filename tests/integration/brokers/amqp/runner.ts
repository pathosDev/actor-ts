/**
 * RabbitMQ/AMQP broker runner (B.5 / #23).
 *
 * We bypass the AmqpActor `bindings` setup-at-connect surface for
 * tests — the scenarios pre-declare queues via the AMQP API directly
 * (using amqplib's library object) and then exercise the actor's
 * `publish` / `ack` / `nack` paths against the declared queues.
 * Same shape used by the unit-test fakes.
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { AmqpActor, type AmqpDelivery, type AmqpQueueBinding } from '../../../../src/io/broker/AmqpActor.js';
import { AmqpOptions } from '../../../../src/io/broker/AmqpOptions.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as pubsubScenario } from './scenarios/01-publish-consume.js';
import { scenario as ackScenario } from './scenarios/02-ack-nack.js';
import { scenario as fanoutScenario } from './scenarios/03-fanout-exchange.js';

export interface AmqpCtx extends BrokerScenarioCtx {
  readonly url: string;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

export class InboxActor extends Actor<AmqpDelivery> {
  readonly received: AmqpDelivery[] = [];
  override onReceive(m: AmqpDelivery): void { this.received.push(m); }
}

async function main(): Promise<void> {
  const url = requireEnv('AMQP_URL');
  const parsed = new URL(url);
  await waitForPort(parsed.hostname, Number(parsed.port || '5672'), {
    description: 'RabbitMQ AMQP', deadlineMs: 60_000,
  });

  const system = ActorSystem.create('amqp-runner', ActorSystemOptions.create()
    .withLogger(new JsonLogger()).withLogLevel(LogLevel.Info));
  process.on('SIGTERM', () => { void system.terminate(); });

  const ctx: AmqpCtx = { env: process.env, url, system };

  try {
    const scenarios: BrokerScenario<AmqpCtx>[] = [
      pubsubScenario,
      ackScenario,
      fanoutScenario,
    ];
    await runScenarios(scenarios, ctx);
  } finally {
    await system.terminate();
  }
}

export function spawnAmqp(ctx: AmqpCtx, opts: {
  bindings?: ReadonlyArray<AmqpQueueBinding>;
  autoAck?: boolean;
} = {}): ReturnType<ActorSystem['spawnAnonymous']> {
  const builder = AmqpOptions.create()
    .withUrl(ctx.url)
    .withAutoAck(opts.autoAck ?? true);
  if (opts.bindings) builder.withBindings(opts.bindings);
  const actor = new AmqpActor(builder);
  return ctx.system.spawnAnonymous(Props.create(() => actor));
}

export function spawnInbox(ctx: AmqpCtx): {
  ref: ReturnType<ActorSystem['spawnAnonymous']>; inbox: InboxActor;
} {
  const inbox = new InboxActor();
  const ref = ctx.system.spawnAnonymous(Props.create(() => inbox));
  return { ref, inbox };
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
