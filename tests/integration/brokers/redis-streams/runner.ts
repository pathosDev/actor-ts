/**
 * Redis Streams broker runner (B.7 / refs #296).
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { RedisStreamsActor, type RedisStreamEntry } from '../../../../src/io/broker/RedisStreamsActor.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as produceScenario } from './scenarios/01-produce.js';
import { scenario as consumeScenario } from './scenarios/02-consume-group.js';
import { scenario as maxlenScenario } from './scenarios/03-maxlen.js';

export interface RedisCtx extends BrokerScenarioCtx {
  readonly url: string;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`runner: missing env var ${name}`);
  return v;
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

  const system = ActorSystem.create('redis-streams-runner', {
    logger: new JsonLogger(), logLevel: LogLevel.Info,
  });
  process.on('SIGTERM', () => { void system.terminate(); });

  const ctx: RedisCtx = { env: process.env, url, system };

  try {
    const scenarios: BrokerScenario<RedisCtx>[] = [
      produceScenario,
      consumeScenario,
      maxlenScenario,
    ];
    await runScenarios(scenarios, ctx);
  } finally {
    await system.terminate();
  }
}

export interface RedisSpawnOpts {
  streams?: ReadonlyArray<string>;
  consumerGroup?: { group: string; consumer: string };
  target?: ReturnType<ActorSystem['spawnAnonymous']>;
}

export function spawnRedis(ctx: RedisCtx, opts: RedisSpawnOpts = {}): ReturnType<ActorSystem['spawnAnonymous']> {
  const actor = new RedisStreamsActor({
    url: ctx.url,
    streams: opts.streams,
    consumerGroup: opts.consumerGroup
      ? { ...opts.consumerGroup, createIfMissing: true }
      : undefined,
    target: opts.target as unknown as undefined,
    blockMs: 500,
  });
  return ctx.system.spawnAnonymous(Props.create(() => actor));
}

export function spawnInbox(ctx: RedisCtx): {
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
