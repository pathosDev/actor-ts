/**
 * Redis Streams broker runner (B.7 / refs #296).
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { RedisStreamsActor, type RedisStreamEntry } from '../../../../src/io/broker/RedisStreamsActor.js';
import { RedisStreamsOptions, RedisStreamsOptionsBuilder } from '../../../../src/io/broker/RedisStreamsOptions.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioContext } from '../lib/scenario.js';
import { scenario as produceScenario } from './scenarios/01-produce.js';
import { scenario as consumeScenario } from './scenarios/02-consume-group.js';
import { scenario as maxlenScenario } from './scenarios/03-maxlen.js';

export interface RedisContext extends BrokerScenarioContext {
  readonly url: string;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

export class InboxActor extends Actor<RedisStreamEntry> {
  readonly received: RedisStreamEntry[] = [];
  override onReceive(m: RedisStreamEntry): void { this.received.push(m); }
}

async function main(): Promise<void> {
  const url = requireEnv('REDIS_URL');
  const parsed = new URL(url);
  await waitForPort(parsed.hostname, Number(parsed.port || '6379'), {
    description: 'Redis', deadlineMs: 15_000,
  });

  const system = ActorSystem.create('redis-streams-runner', ActorSystemOptions.create()
    .withLogger(new JsonLogger()).withLogLevel(LogLevel.Info));
  process.on('SIGTERM', () => { void system.terminate(); });

  const context: RedisContext = { env: process.env, url, system };

  try {
    const scenarios: BrokerScenario<RedisContext>[] = [
      produceScenario,
      consumeScenario,
      maxlenScenario,
    ];
    await runScenarios(scenarios, context);
  } finally {
    await system.terminate();
  }
}

export interface RedisSpawnOpts {
  streams?: ReadonlyArray<string>;
  consumerGroup?: { group: string; consumer: string };
  target?: ReturnType<ActorSystem['spawnAnonymous']>;
}

export function spawnRedis(context: RedisContext, options: RedisSpawnOpts = {}): ReturnType<ActorSystem['spawnAnonymous']> {
  const builder = RedisStreamsOptions.create()
    .withUrl(context.url)
    .withBlockMs(500);
  if (options.streams) builder.withStreams(options.streams);
  if (options.consumerGroup) builder.withConsumerGroup({ ...options.consumerGroup, createIfMissing: true });
  if (options.target) builder.withTarget(options.target as unknown as Parameters<RedisStreamsOptionsBuilder['withTarget']>[0]);
  const actor = new RedisStreamsActor(builder);
  return context.system.spawnAnonymous(Props.create(() => actor));
}

export function spawnInbox(context: RedisContext): {
  ref: ReturnType<ActorSystem['spawnAnonymous']>; inbox: InboxActor;
} {
  const inbox = new InboxActor();
  const ref = context.system.spawnAnonymous(Props.create(() => inbox));
  return { ref, inbox };
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
