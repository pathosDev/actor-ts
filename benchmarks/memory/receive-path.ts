/**
 * What does *delivering* a message allocate, with instrumentation off?
 *
 * The sibling `queued-messages.ts` measures the enqueue side and structurally
 * cannot answer this: its latch wedges the actor on its first message, so
 * `handleUserMessage` runs exactly once inside the measured window while the
 * send path runs N times.  Most of what #411 removes lives on the receive
 * side, and none of it was visible there.
 *
 * Here the batch is drained to completion inside the window — one `ask` at the
 * end is what proves it — so every message pays the full path: envelope in,
 * span decision, MDC decision, behavior, and the `finally` that used to build
 * two metric label objects and read two clocks for a registry that discards
 * them.
 *
 * Three arms, because "allocates less" is only meaningful against what the
 * knobs actually change:
 *
 * - **idle** — no instrumentation, the shape virtually every production
 *   deployment runs.  This is the row #411 moves.
 * - **metrics on** — the counter and histogram arguments are built and
 *   recorded, so the row shows what instrumentation genuinely costs rather
 *   than what it cost when it was switched off.
 * - **MDC scope** — every send carries a context, so each delivery adds an
 *   `AsyncLocalStorage` frame and the one closure the fast path avoids.  It is
 *   here to keep the empty-context fast path honest: if `LogContext.isEmpty`
 *   ever regressed into attaching `{}`, the idle row would quietly converge on
 *   this one.
 *
 * **Read the numbers as retention under a forced GC, not as an allocation
 * count** — and know what that means before drawing a conclusion from them.
 * `memoryGroup` brackets each arm with `Bun.gc(true)` since #411; before that
 * the probe looked only for `globalThis.gc`, which needs `--expose-gc`, so
 * nothing collected and every row was un-GC'd process noise.
 *
 * The honest consequence, recorded here because #411's acceptance criterion
 * asked for "Δheap/message down" and this is the answer: **it cannot show
 * that, and neither can any retention metric.**  Everything #411 removed —
 * four extension lookups, four metric label objects, a closure, a keys array,
 * two clock reads per message — is short-lived garbage that never survives a
 * collection.  Measured here after the change, the idle arm's heap delta over
 * 50 000 deliveries is *negative* (the forced GC reclaims more than the run
 * retains), which is the correct reading of "this path retains nothing" and
 * was equally true before.  A row that is noise on both sides of a change
 * cannot be evidence for it.
 *
 * What that garbage actually cost was GC pressure, and pressure shows up as
 * time: `benchmarks/single-node/tell-throughput.ts` moved 17-34 % on #411
 * alone.  That is the measurement to regress against.  This file earns its
 * place by keeping the three arms *comparable to each other* — if the idle row
 * ever converges on the MDC row, the empty-context fast path has regressed —
 * not by producing an absolute per-message byte count.
 *
 *   bun run benchmarks/memory/receive-path.ts
 */
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  LogContext,
  LogLevel,
  NoopLogger,
} from '../../src/index.js';
import { MetricsExtensionId } from '../../src/metrics/MetricsExtension.js';
import { memoryGroup } from '../lib/harness.js';

type Message = { kind: 'work' } | { kind: 'drained' };

class Worker extends Actor<Message> {
  private handled = 0;
  override onReceive(m: Message): void {
    if (m.kind === 'work') this.handled += 1;
    else this.sender.forEach((s) => s.tell(this.handled));
  }
}

const MESSAGES = 50_000;

/**
 * Drive `MESSAGES` deliveries all the way through the receive path.
 *
 * The trailing `ask` is load-bearing: it only replies once the whole batch
 * ahead of it has been handled, which is what makes the measured window
 * contain N *deliveries* rather than N enqueues.
 */
async function drive(system: ActorSystem, withinScope: boolean): Promise<void> {
  const ref = system.spawnAnonymous(Worker);
  const send = (): void => {
    for (let index = 0; index < MESSAGES; index++) ref.tell({ kind: 'work' });
  };
  if (withinScope) LogContext.run({ tenant: 'acme', requestId: 'r-1' }, send);
  else send();
  await ref.ask<number>({ kind: 'drained' }, 60_000);
  ref.stop();
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-receive-path', systemOptions);

  const group = memoryGroup(`memory · receive path (${MESSAGES.toLocaleString()} deliveries)`);

  // Warm up first — a cold run measures the JIT and the lazily-created
  // extension singletons, not the path.
  await drive(system, false);

  await group.measure('idle — no metrics, no tracing, no MDC', () => drive(system, false));

  await group.measure('MDC scope on every send', () => drive(system, true));

  system.extension(MetricsExtensionId).enable();
  await drive(system, false); // warm the freshly-installed registry
  await group.measure('metrics enabled', () => drive(system, false));
  system.extension(MetricsExtensionId).disable();

  group.end();
  await system.terminate();
}

void main();
