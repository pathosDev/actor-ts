/**
 * NATS-Core broker runner (B.6 / #24).
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { NatsActor, type NatsMessage } from '../../../../src/io/broker/NatsActor.js';
import { NatsOptions } from '../../../../src/io/broker/NatsOptions.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as pubsubScenario } from './scenarios/01-publish-subscribe.js';
import { scenario as wildcardScenario } from './scenarios/02-wildcard.js';
import { scenario as multiSubScenario } from './scenarios/03-multiple-subscribers.js';

export interface NatsCtx extends BrokerScenarioCtx {
  readonly servers: ReadonlyArray<string>;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`runner: missing env var ${name}`);
  return v;
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

  const ctx: NatsCtx = { env: process.env, servers, system };

  try {
    const scenarios: BrokerScenario<NatsCtx>[] = [
      pubsubScenario,
      wildcardScenario,
      multiSubScenario,
    ];
    await runScenarios(scenarios, ctx);
  } finally {
    await system.terminate();
  }
}

export function spawnNats(ctx: NatsCtx): ReturnType<ActorSystem['spawnAnonymous']> {
  const actor = new NatsActor(
    NatsOptions.create()
      .withServers([...ctx.servers])
      .withName(`actor-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  );
  return ctx.system.spawnAnonymous(Props.create(() => actor));
}

export function spawnInbox(ctx: NatsCtx): {
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
