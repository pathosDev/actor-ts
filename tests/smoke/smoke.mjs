/**
 * Cross-runtime smoke test.  Runs identically on Bun, Node.js 20+ and
 * Deno without any test-framework dependency — just assertions + plain
 * exit codes.  Exercises the three touch points most likely to break
 * when switching runtimes:
 *
 *   1. Module loading (import works, no runtime globals missing)
 *   2. Core actor messaging (spawn an actor, hit it with 10k tells,
 *      read back a counter via `ask`)
 *   3. InMemory cluster formation (two nodes see each other as Up)
 *
 * Intentionally skips subsystems that need optional peers / native
 * bindings (TCP transport, Hono+Bun.serve, better-sqlite3, Cassandra).
 * Those get their own integration tests; the point of this script is to
 * catch "the framework can't even boot on runtime X" regressions.
 *
 * Usage:
 *   bun  tests/smoke/smoke.mjs
 *   node tests/smoke/smoke.mjs
 *   deno run --allow-read tests/smoke/smoke.mjs
 */

// Dynamic imports so runtime-specific TS loaders can handle the .ts source.
// On Bun and Deno .ts files load natively.  Node 22+ has `--experimental-strip-types`,
// but callers who run on older Node should build first and import from dist/.
const importFromBuild = process.env.ACTOR_TS_SMOKE_USE_DIST === '1';
const basePath = importFromBuild ? '../../dist/index.js' : '../../src/index.ts';
const modUrl = new URL(basePath, import.meta.url).href;

let actorTs;
try {
  actorTs = await import(modUrl);
} catch (e) {
  console.error(`✗ failed to import actor-ts from ${modUrl}:\n${e.stack ?? e.message ?? e}`);
  process.exit(1);
}
const {
  Actor, ActorSystem, Cluster, InMemoryTransport, LogLevel,
  NoopLogger, NodeAddress, Props, ask,
} = actorTs;

const runtime = detectRuntime();
console.log(`→ smoke test on ${runtime}`);

let failed = 0;

/* ---------------------------- test 1: core ------------------------------- */

try {
  class Counter extends Actor {
    constructor() { super(); this.n = 0; }
    onReceive(m) {
      if (m === 'inc') this.n++;
      else this.sender.forEach((s) => s.tell(this.n));
    }
  }
  const sys = ActorSystem.create('smoke-core', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const ref = sys.actorOf(Props.create(() => new Counter()));
  const N = 10_000;
  for (let i = 0; i < N; i++) ref.tell('inc');
  const got = await ask(ref, 'get', 5_000);
  if (got !== N) throw new Error(`counter mismatch: ${got} !== ${N}`);
  await sys.terminate();
  console.log(`✓ core messaging — ${N} tells, counter = ${got}`);
} catch (e) {
  console.error(`✗ core messaging: ${e.message}`);
  failed++;
}

/* ---------------------------- test 2: cluster ---------------------------- */

try {
  const [a, b] = await Promise.all([
    buildNode('smoke-cluster', 55801, []),
    buildNode('smoke-cluster', 55802, ['smoke-cluster@h:55801']),
  ]);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2) break;
    await sleep(25);
  }
  const upA = a.cluster.upMembers().length;
  const upB = b.cluster.upMembers().length;
  if (upA !== 2 || upB !== 2) throw new Error(`cluster failed to converge (a=${upA}, b=${upB})`);
  await a.cluster.leave(); await a.sys.terminate();
  await b.cluster.leave(); await b.sys.terminate();
  console.log(`✓ cluster formation — 2 nodes Up on both sides`);
} catch (e) {
  console.error(`✗ cluster formation: ${e.message}`);
  failed++;
}

/* ---------------------------- summary ------------------------------------ */

if (failed === 0) {
  console.log(`\n✓ all smoke checks passed on ${runtime}`);
  process.exit(0);
} else {
  console.error(`\n✗ ${failed} smoke check(s) failed on ${runtime}`);
  process.exit(1);
}

/* ---------------------------- helpers ------------------------------------ */

function detectRuntime() {
  if (typeof globalThis.Bun !== 'undefined') return 'bun';
  if (typeof globalThis.Deno !== 'undefined') return 'deno';
  return 'node';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function buildNode(sysName, port, seeds) {
  const sys = ActorSystem.create(sysName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(sys, {
    host: 'h', port, seeds,
    transport: new InMemoryTransport(new NodeAddress(sysName, 'h', port)),
    gossipIntervalMs: 30,
  });
  return { sys, cluster };
}
