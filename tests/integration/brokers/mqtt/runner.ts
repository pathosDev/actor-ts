/**
 * Mosquitto/MQTT broker runner (B.3 / #21).
 *
 * Boots an ActorSystem with a single MqttActor connected to the
 * Mosquitto broker, then runs every scenario.  Each scenario shares
 * the system + actor — connect costs ~50ms, fan-out of multiple
 * scenarios over one actor keeps the suite under 5s wall clock.
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { MqttActor, type MqttMessage } from '../../../../src/io/broker/MqttActor.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as pubsubScenario } from './scenarios/01-publish-subscribe.js';
import { scenario as qos1Scenario } from './scenarios/02-qos1.js';
import { scenario as qos2Scenario } from './scenarios/03-qos2.js';
import { scenario as retainedScenario } from './scenarios/04-retained.js';
import { scenario as wildcardScenario } from './scenarios/05-wildcard.js';

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
 * Inbox actor — drains MqttMessages into an in-memory array so a
 * scenario can `await waitFor(() => box.received.includes('expected'))`.
 * One per topic-pattern keeps cross-scenario state separate.
 */
export class InboxActor extends Actor<MqttMessage> {
  readonly received: MqttMessage[] = [];
  override onReceive(m: MqttMessage): void { this.received.push(m); }
}

async function main(): Promise<void> {
  const brokerUrl = requireEnv('MQTT_BROKER_URL');
  // Wait for the broker socket before constructing the ActorSystem;
  // MqttActor reconnects on its own, but starting on a closed port
  // costs us a 3-second backoff in every scenario's setup.
  const url = new URL(brokerUrl);
  await waitForPort(url.hostname, Number(url.port || '1883'), {
    description: 'Mosquitto MQTT', deadlineMs: 30_000,
  });

  const system = ActorSystem.create('mqtt-runner', {
    logger: new JsonLogger(),
    logLevel: LogLevel.Info,
  });
  process.on('SIGTERM', () => { void system.terminate(); });

  const ctx: MqttCtx = {
    env: process.env,
    brokerUrl,
    system,
  };

  try {
    const scenarios: BrokerScenario<MqttCtx>[] = [
      pubsubScenario,
      qos1Scenario,
      qos2Scenario,
      retainedScenario,
      wildcardScenario,
    ];
    await runScenarios(scenarios, ctx);
  } finally {
    await system.terminate();
  }
}

/** Fresh MqttActor instance per scenario — keeps state isolated. */
export function spawnMqtt(ctx: MqttCtx, opts: {
  protocolVersion?: 4 | 5;
  clientId?: string;
} = {}): {
  ref: ReturnType<ActorSystem['spawnAnonymous']>;
} {
  const actor = new MqttActor({
    brokerUrl: ctx.brokerUrl,
    clientId: opts.clientId ?? `actor-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    protocolVersion: opts.protocolVersion ?? 4,
    cleanSession: true,
  });
  const ref = ctx.system.spawnAnonymous(Props.create(() => actor));
  return { ref };
}

/** Spawn a fresh inbox actor whose received messages are observable. */
export function spawnInbox(ctx: MqttCtx): { ref: ReturnType<ActorSystem['spawnAnonymous']>; inbox: InboxActor } {
  const inbox = new InboxActor();
  const ref = ctx.system.spawnAnonymous(Props.create(() => inbox));
  return { ref, inbox };
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
