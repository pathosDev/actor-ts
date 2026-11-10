/**
 * NATS-Core broker runner (B.6 / #24).
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { NatsActor, type NatsMessage } from '../../../../src/io/broker/NatsActor.js';
import { NatsOptions } from '../../../../src/io/broker/NatsOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioContext } from '../lib/Scenario.js';
import { scenario as pubsubScenario } from './scenarios/01-publish-subscribe.js';
import { scenario as wildcardScenario } from './scenarios/02-wildcard.js';
import { scenario as multiSubScenario } from './scenarios/03-multiple-subscribers.js';
import { scenario as driverShapeScenario } from './scenarios/00-driver-shape.js';
import { scenario as jetStreamPushScenario } from './scenarios/04-jetstream-push.js';
import { scenario as jetStreamPullScenario } from './scenarios/05-jetstream-pull.js';
import { scenario as keyValueScenario } from './scenarios/06-jetstream-key-value.js';
import { scenario as objectStoreScenario } from './scenarios/07-jetstream-object-store.js';

export interface NatsContext extends BrokerScenarioContext {
  readonly servers: ReadonlyArray<string>;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

export class InboxActor extends Actor<NatsMessage> {
  readonly received: NatsMessage[] = [];
  override onReceive(m: NatsMessage): void { this.received.push(m); }
}

async function main(): Promise<void> {
  const raw = requireEnv('NATS_SERVERS');
  const servers = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const url = new URL(servers[0]!);
  await waitForPort(url.hostname, Number(url.port || '4222'), {
    description: 'NATS server', deadlineMs: 15_000,
  });

  const system = ActorSystem.create('nats-runner', ActorSystemOptions.create()
    .withLogger(new JsonLogger()).withLogLevel(LogLevel.Info));
  process.on('SIGTERM', () => { void system.terminate(); });

  const context: NatsContext = { env: process.env, servers, system };

  try {
    const scenarios: BrokerScenario<NatsContext>[] = [
      // Shape first: if the driver surface moved, every scenario below fails
      // in the same confusing way, and this one says so in a line.
      driverShapeScenario,
      pubsubScenario,
      wildcardScenario,
      multiSubScenario,
      jetStreamPushScenario,
      jetStreamPullScenario,
      keyValueScenario,
      objectStoreScenario,
    ];
    await runScenarios(scenarios, context);
  } finally {
    await system.terminate();
  }
}

/**
 * Unique stream, subject, durable and bucket names for one JetStream
 * scenario.
 *
 * JetStream state outlives an actor — a stream a previous run created is
 * still there, with its consumers and their delivery positions — so reusing
 * a name would make a scenario depend on what ran before it.  Stream and
 * bucket names are also constrained: no dots, no spaces, and the server is
 * case-sensitive about them.
 */
export function jetStreamNames(prefix: string): {
  stream: string; subject: string; durable: string; bucket: string;
} {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    .replace(/[^a-z0-9]/g, '');
  return {
    stream: `${prefix}${unique}`.toUpperCase(),
    subject: `${prefix}${unique}`,
    durable: `${prefix}${unique}proc`,
    bucket: `${prefix}${unique}`,
  };
}

export function spawnNats(context: NatsContext): ReturnType<ActorSystem['spawnAnonymous']> {
  const actor = new NatsActor(
    NatsOptions.create()
      .withServers([...context.servers])
      .withName(`actor-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  );
  return context.system.spawnAnonymous(() => actor);
}

export function spawnInbox(context: NatsContext): {
  ref: ReturnType<ActorSystem['spawnAnonymous']>; inbox: InboxActor;
} {
  const inbox = new InboxActor();
  const ref = context.system.spawnAnonymous(() => inbox);
  return { ref, inbox };
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
