/**
 * The floor: the same four scenarios with no framework at all (#27).
 *
 * This arm is not a competitor.  It is the lower bound — plain objects, direct
 * method calls, and a bare `Promise` where the scenario needs a reply — so
 * every framework row can be read as "what the abstraction costs" instead of
 * only as "faster or slower than the others".  A comparison of three
 * frameworks tells you which to pick; a comparison of three frameworks against
 * the floor also tells you whether to use one at all.
 *
 * It is also how the project's own published claims get checked.  The FAQ has
 * long asserted a per-message overhead and a "50-200x a direct call" ratio
 * with no measurement behind either; this arm is the direct call in that
 * ratio.
 *
 * Every row carries a note saying what it is, because a table where one column
 * is 100x the others invites exactly the wrong reading: the floor does no
 * queueing, no supervision, no lifecycle, no location transparency and no
 * back-pressure.  It is not an actor system with the overhead removed — it is
 * the thing an actor system is built out of.
 *
 *   bun run benchmarks/comparison/js/vanilla.ts
 */
import { runArm, type ArmCase } from './arm.js';
import { workloadCase } from './workload.js';

const FLOOR_NOTE =
  'Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.';

/**
 * The closest a plain object gets to an actor's lifecycle: it exists, and then
 * it is explicitly finished with.  Both transitions are synchronous, which is
 * the entire content of this row — actor-ts, like most actor frameworks,
 * defers construction to a scheduler turn and this does not.
 */
class PlainMailbox {
  private disposed = false;

  dispose(): void {
    this.disposed = true;
  }

  get alive(): boolean {
    return !this.disposed;
  }
}

class PlainCounter {
  private count = 0;

  increment(): void {
    this.count++;
  }

  readAndReset(): number {
    const observed = this.count;
    this.count = 0;
    return observed;
  }
}

class PlainEcho {
  /**
   * `Promise.resolve` rather than a synchronous return: the scenario is a
   * request/response round trip, and awaiting one microtask is the floor for
   * that, not zero.
   */
  echo(message: string): Promise<string> {
    return Promise.resolve(`echo:${message}`);
  }
}

class PlainPong {
  pong(): void {}
}

class PlainPing {
  private readonly partner: PlainPong;

  // Spelled out rather than written as a constructor parameter property.
  // Parameter properties are not erasable, so Node's strip-only TypeScript
  // mode refuses the file outright.  The arms run on Bun today (see the
  // runtime note in ../README.md), but keeping them free of non-erasable
  // syntax costs nothing and is half of what a Node run would need.
  constructor(partner: PlainPong) {
    this.partner = partner;
  }

  volley(exchanges: number): number {
    let completed = 0;
    for (let i = 0; i < exchanges; i++) {
      this.partner.pong();
      completed++;
    }
    return completed;
  }
}

async function main(): Promise<void> {
  const counter = new PlainCounter();
  const echo = new PlainEcho();
  const ping = new PlainPing(new PlainPong());

  const spawnWorkload = workloadCase('spawn', 'batch=100');
  const tellSmall = workloadCase('tell-throughput', 'batch=1k');
  const tellLarge = workloadCase('tell-throughput', 'batch=10k');
  const askWorkload = workloadCase('ask-round-trip', 'sequential');
  const pingPongWorkload = workloadCase('ping-pong', 'exchanges=10k');

  const constructBatch = (batch: number): number => {
    const mailboxes: PlainMailbox[] = [];
    for (let i = 0; i < batch; i++) mailboxes.push(new PlainMailbox());
    const alive = mailboxes.filter((mailbox) => mailbox.alive).length;
    for (const mailbox of mailboxes) mailbox.dispose();
    const disposed = mailboxes.filter((mailbox) => !mailbox.alive).length;
    return Math.min(alive, disposed);
  };

  const tellBatch = (batch: number): number => {
    for (let i = 0; i < batch; i++) counter.increment();
    return counter.readAndReset();
  };

  const cases: ArmCase[] = [
    {
      workload: spawnWorkload,
      notes: `${FLOOR_NOTE}  Construction and disposal are synchronous, so there is no start to wait for.`,
      run: () => constructBatch(spawnWorkload.opsPerIteration),
    },
    { workload: tellSmall, notes: FLOOR_NOTE, run: () => tellBatch(tellSmall.opsPerIteration) },
    { workload: tellLarge, notes: FLOOR_NOTE, run: () => tellBatch(tellLarge.opsPerIteration) },
    {
      workload: askWorkload,
      notes: `${FLOOR_NOTE}  One awaited microtask is the floor for a request/response pair.`,
      run: async () => {
        const reply = await echo.echo('hi');
        return reply === 'echo:hi' ? 1 : 0;
      },
    },
    {
      workload: pingPongWorkload,
      notes: `${FLOOR_NOTE}  Two objects calling each other in a loop — no scheduling between hops.`,
      run: () => ping.volley(pingPongWorkload.opsPerIteration),
    },
  ];

  await runArm({
    framework: { name: 'vanilla', version: 'n/a', language: 'TypeScript', license: 'MIT' },
    cases,
  });
}

void main();
