/**
 * A child that occasionally throws, supervised by a parent that restarts it.
 *
 *   tsx examples/supervision.ts
 */
import {
  Actor,
  ActorSystem,
  OneForOneStrategy,
  Directive,
  decideBy,
} from '../src/index.js';
import type { ActorRef } from '../src/index.js';

class FlakyWorker extends Actor<number> {
  private handled = 0;

  override preStart(): void {
    this.log.info('worker started');
  }

  override postStop(): void {
    this.log.info(`worker stopping — handled ${this.handled} before stop`);
  }

  override preRestart(cause: Error): void {
    this.log.warn(`worker restarting, reason: ${cause.message}`);
  }

  override onReceive(n: number): void {
    this.handled++;
    if (n % 3 === 0) throw new Error(`boom on ${n}`);
    console.log(`[worker] processed ${n}`);
  }
}

class ParentActor extends Actor<number> {
  private worker!: ActorRef<number>;

  override supervisorStrategy() {
    return new OneForOneStrategy(
      decideBy([{ match: RangeError, then: Directive.Stop }], Directive.Restart),
      { maxRetries: 10, withinTimeRangeMs: 5_000 },
    );
  }

  override preStart(): void {
    this.worker = this.context.spawn(FlakyWorker, 'worker');
  }

  override onReceive(n: number): void {
    this.worker.tell(n);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('supervision');
  const parent = system.spawn(ParentActor, 'parent');

  for (let i = 1; i <= 6; i++) parent.tell(i);

  // Restarts happen inside the drain: a failure suspends the child, the
  // supervisor's decision resumes it, and the queue behind it keeps the tree
  // busy until every message has been through.
  await system.terminate();
}

void main();
