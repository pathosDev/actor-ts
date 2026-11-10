/**
 * Actor creation/destruction rate — how fast can we spawn and stop an
 * actor?  Measures spawn + stop as one op.
 *
 * The last two arms price the `actor-ts.deployment` lookup (#868) that every
 * spawn of an application actor goes through.  The block holds ten wildcard
 * keys that match nothing and then `/user/**`, which matches every actor
 * spawned here: the lookup's worst case, since the actor's name cannot rule
 * `/user/**` out, so every spawn walks its path and tries the keys in turn.
 * Its control is the same op on a fresh system without a block, measured
 * right after it.  Compare the two with each other, not with the first arm:
 * an arm inherits whatever the arms before it warmed up, and the first arm
 * runs cold — measured, the block's arm reads a quarter faster than the first
 * one.  The control goes second because order favours the later arm: run
 * the other way round, the block measured about +22 % over its control
 * against about +31 % this way, so the ratio printed here is an upper
 * estimate of what the block costs.
 *
 *   bun run benchmarks/single-node/actor-creation.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

class Noop extends Actor<unknown> { override onReceive(): void {} }

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-create', systemOptions);

  const deploymentBlock = {
    '/user/ingest-*': { 'mailbox-capacity': 10_000 },
    '/user/telemetry-*': { 'mailbox-overflow': 'drop-head' },
    '/user/chat/ws-*': { 'mailbox-capacity': 256 },
    '/user/pool/worker-*': { throughput: 64 },
    '/user/router-*/routee-*': { throughput: 32 },
    '/user/api/**': { 'mailbox-capacity': 1_000 },
    '/user/jobs/**': { throughput: 4 },
    '/user/sessions/*/**': { 'mailbox-capacity': 64 },
    '/system/cluster/sharding/region-orders/**': { 'mailbox-capacity': 5_000 },
    '/system/cluster/sharding/region-users/**': { 'mailbox-capacity': 5_000 },
    '/user/**': { throughput: 16 },
  };
  const deploymentOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { deployment: deploymentBlock } });
  const deploymentSystem = ActorSystem.create('bench-create-deployment', deploymentOptions);
  const controlOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const controlSystem = ActorSystem.create('bench-create-control', controlOptions);

  await runGroup('single-node · actor-creation', [
    {
      name: 'spawn + stop (flat)',
      unit: 'actor',
      iterations: 5_000,
      run: () => {
        const ref = system.spawnAnonymous(Noop);
        ref.stop();
      },
    },
    {
      name: 'spawn 100-deep sibling burst',
      unit: 'actor',
      iterations: 100,
      opsPerIteration: 100,
      run: () => {
        const refs = [];
        for (let i = 0; i < 100; i++) refs.push(system.spawnAnonymous(Noop));
        for (const r of refs) r.stop();
      },
    },
    {
      name: 'spawn + stop (deployment block)',
      unit: 'actor',
      iterations: 5_000,
      run: () => {
        const ref = deploymentSystem.spawnAnonymous(Noop);
        ref.stop();
      },
    },
    {
      name: 'spawn + stop (its control, no block)',
      unit: 'actor',
      iterations: 5_000,
      run: () => {
        const ref = controlSystem.spawnAnonymous(Noop);
        ref.stop();
      },
    },
  ]);

  await system.terminate();
  await deploymentSystem.terminate();
  await controlSystem.terminate();
}

void main();
