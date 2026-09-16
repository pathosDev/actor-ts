/**
 * The same application, single-threaded or on worker threads — the only
 * difference is one config number.
 *
 *   bun run examples/parallelism/main.ts                      # workers = 0
 *   ACTOR_TS_WORKERS=4 bun run examples/parallelism/main.ts   # four threads
 *   ACTOR_TS_WORKERS=auto bun run examples/parallelism/main.ts
 *
 * Eight `Hasher` actors each get a CPU-bound message; the checksum over
 * their answers is identical whatever the thread count, and the `where`
 * column shows which node each one ran on.  The actor module is
 * `./actors.ts`, found by convention next to this file; nothing here names
 * it, and nothing here knows whether a thread is involved.
 */
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Hasher, type HashResult } from './actors.js';

const ACTORS = 8;
const ROUNDS = 2_000_000;

async function main(): Promise<void> {
  // Straight from the environment into the config block: the knob is HOCON,
  // and an application does not usually read it from the environment — this
  // one does so the same file can be run both ways.
  const raw = process.env.ACTOR_TS_WORKERS ?? '0';
  const workers = raw === 'auto' ? 'auto' : Number.parseInt(raw, 10);
  const systemOptions = ActorSystemOptions.create()
    .withConfig({ 'actor-ts': { parallelism: { workers }, cluster: { 'gossip-interval': '40ms' } } });
  const system = ActorSystem.create('parallelism-example', systemOptions);

  const hashers = Array.from({ length: ACTORS }, (_, i) => system.spawn(Hasher, `hasher-${i}`));
  const round = (rounds: number): Promise<HashResult[]> => Promise.all(
    hashers.map((ref, i) => ref.ask<HashResult>({ kind: 'hash', seed: i + 1, rounds }, 60_000)),
  );
  // One untimed round first: with threads it absorbs the mesh coming up and
  // the module loading on every worker, so the timed one measures the work.
  await round(1);
  const started = performance.now();
  const results = await round(ROUNDS);
  const elapsedMs = performance.now() - started;

  let checksum = 0;
  for (const result of results) checksum = (checksum + result.value) | 0;
  for (const result of results) console.log(`hasher seed=${result.seed} ran on ${result.where}`);
  console.log(`workers = ${raw}: checksum ${checksum} over ${ACTORS} actors in ${elapsedMs.toFixed(0)} ms`);

  await system.terminate();
  console.log('terminated');
}

void main();
