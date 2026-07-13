/**
 * Redpanda/Kafka broker runner (B.4 / #22).
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { KafkaActor, type KafkaRecord } from '../../../../src/io/broker/KafkaActor.js';
import { KafkaOptions, KafkaOptionsBuilder } from '../../../../src/io/broker/KafkaOptions.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as pubsubScenario } from './scenarios/01-publish-consume.js';
import { scenario as groupScenario } from './scenarios/02-consumer-group.js';
import { scenario as manualScenario } from './scenarios/03-manual-commit.js';
import { scenario as headersScenario } from './scenarios/04-headers.js';

export interface KafkaCtx extends BrokerScenarioCtx {
  readonly brokers: ReadonlyArray<string>;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

/** Inbox actor — drains KafkaRecords for assertion. */
export class InboxActor extends Actor<KafkaRecord> {
  readonly received: KafkaRecord[] = [];
  override onReceive(m: KafkaRecord): void { this.received.push(m); }
}

async function main(): Promise<void> {
  const bootstrap = requireEnv('KAFKA_BROKERS');
  const brokers = bootstrap.split(',').map((s) => s.trim()).filter(Boolean);

  // Wait for the first broker socket — same flake guard as the
  // other suites.  Redpanda's accept loop is up well before
  // `rpk cluster info` reports healthy, so the compose healthcheck
  // is the strict gate; this is belts-and-braces.
  const [hostPort] = brokers;
  const [host, port] = hostPort!.split(':');
  await waitForPort(host!, Number(port ?? '9092'), {
    description: 'Redpanda Kafka API', deadlineMs: 30_000,
  });

  const system = ActorSystem.create('kafka-runner', ActorSystemOptions.create()
    .withLogger(new JsonLogger())
    .withLogLevel(LogLevel.Info));
  process.on('SIGTERM', () => { void system.terminate(); });

  const ctx: KafkaCtx = { env: process.env, brokers, system };

  try {
    const scenarios: BrokerScenario<KafkaCtx>[] = [
      pubsubScenario,
      groupScenario,
      manualScenario,
      headersScenario,
    ];
    await runScenarios(scenarios, ctx);
  } finally {
    await system.terminate();
  }
}

export interface KafkaSpawnOpts {
  groupId?: string;
  topics?: ReadonlyArray<string>;
  target?: ReturnType<ActorSystem['spawnAnonymous']>;
  commitMode?: 'auto' | 'manual';
  fromBeginning?: boolean;
}

/** Fresh KafkaActor per scenario.  groupId default ensures isolation. */
export function spawnKafka(ctx: KafkaCtx, opts: KafkaSpawnOpts = {}): ReturnType<ActorSystem['spawnAnonymous']> {
  const builder = KafkaOptions.create()
    .withBrokers([...ctx.brokers])
    .withClientId(`actor-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .withProducer({ allowAutoTopicCreation: true, idempotent: false });
  if (opts.groupId) {
    builder.withConsumer({
      groupId: opts.groupId,
      fromBeginning: opts.fromBeginning ?? true,
      commitMode: opts.commitMode ?? 'auto',
    });
  }
  if (opts.topics) builder.withTopics(opts.topics);
  if (opts.target) builder.withTarget(opts.target as unknown as Parameters<KafkaOptionsBuilder['withTarget']>[0]);
  const actor = new KafkaActor(builder);
  return ctx.system.spawnAnonymous(Props.create(() => actor));
}

export function spawnInbox(ctx: KafkaCtx): {
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
