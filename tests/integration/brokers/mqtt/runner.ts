/**
 * Mosquitto/MQTT broker runner (B.3 / #21).
 *
 * Boots an ActorSystem and runs every scenario against a real Mosquitto
 * broker.  Each scenario spawns its own fresh actor(s) so state stays
 * isolated; connect costs ~50ms per actor.
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem, ActorSystemOptions } from '../../../../src/ActorSystem.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { MqttActor, type MqttMessage } from '../../../../src/io/broker/MqttActor.js';
import { MqttOptions } from '../../../../src/io/broker/MqttOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import type { MqttRef } from '../../../../src/io/broker/MqttMessages.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as pubsubScenario } from './scenarios/01-publish-subscribe.js';
import { scenario as qos1Scenario } from './scenarios/02-qos1.js';
import { scenario as qos2Scenario } from './scenarios/03-qos2.js';
import { scenario as retainedScenario } from './scenarios/04-retained.js';
import { scenario as wildcardScenario } from './scenarios/05-wildcard.js';
import { scenario as typedScenario } from './scenarios/06-typed-entities.js';

export interface MqttCtx extends BrokerScenarioCtx {
  readonly brokerUrl: string;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`runner: missing env var ${name}`);
  return v;
}

/**
 * Concrete MqttActor used as a pure external router — it carries no own
 * subscriptions, so inbound routing goes entirely to the `target` refs
 * supplied on `subscribe` commands.  `onMessage` is never reached.
 */
class RouterMqttActor extends MqttActor {
  constructor(opts: MqttOptions) { super(opts); }
  override onMessage(_msg: MqttMessage): void { /* external-target routing only */ }
}

/**
 * Inbox actor — drains MqttMessages into an in-memory array so a
 * scenario can `await waitFor(() => box.received.some(...))`.
 */
export class InboxActor extends Actor<MqttMessage> {
  readonly received: MqttMessage[] = [];
  override onReceive(m: MqttMessage): void { this.received.push(m); }
}

async function main(): Promise<void> {
  const brokerUrl = requireEnv('MQTT_BROKER_URL');
  const url = new URL(brokerUrl);
  await waitForPort(url.hostname, Number(url.port || '1883'), {
    description: 'Mosquitto MQTT', deadlineMs: 30_000,
  });

  const system = ActorSystem.create('mqtt-runner', ActorSystemOptions.create()
    .withLogger(new JsonLogger())
    .withLogLevel(LogLevel.Info));
  process.on('SIGTERM', () => { void system.terminate(); });

  const ctx: MqttCtx = { env: process.env, brokerUrl, system };

  try {
    const scenarios: BrokerScenario<MqttCtx>[] = [
      pubsubScenario,
      qos1Scenario,
      qos2Scenario,
      retainedScenario,
      wildcardScenario,
      typedScenario,
    ];
    await runScenarios(scenarios, ctx);
  } finally {
    await system.terminate();
  }
}

/** Fresh router MqttActor instance per scenario — keeps state isolated. */
export function spawnMqtt(ctx: MqttCtx, opts: {
  protocolVersion?: 4 | 5;
  clientId?: string;
} = {}): { ref: MqttRef } {
  const actor = new RouterMqttActor(
    MqttOptions.create()
      .withBrokerUrl(ctx.brokerUrl)
      .withClientId(opts.clientId ?? `actor-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .withProtocolVersion(opts.protocolVersion ?? 4)
      .withCleanSession(true),
  );
  const ref = ctx.system.spawnAnonymous(Props.create(() => actor));
  return { ref };
}

/** Spawn a fresh inbox actor whose received messages are observable. */
export function spawnInbox(ctx: MqttCtx): { ref: ActorRef<MqttMessage>; inbox: InboxActor } {
  const inbox = new InboxActor();
  const ref = ctx.system.spawnAnonymous(Props.create(() => inbox));
  return { ref, inbox };
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
