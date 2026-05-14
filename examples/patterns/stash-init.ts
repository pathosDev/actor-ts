/**
 * Stash example — buffer user commands while the actor finishes an async
 * initialisation, then replay them once ready.
 *
 *   bun run examples/patterns/stash-init.ts
 */
import { Actor, ActorSystem, Props } from '../../src/index.js';

type Cmd =
  | { kind: 'query'; q: string }
  | { kind: '__ready' };

class LoadingRepo extends Actor<Cmd> {
  private ready = false;
  private data: Record<string, number> = {};

  override preStart(): void {
    // Simulate an async load — 80 ms later we flip to "ready".
    this.context.timers.startSingleTimer('load', { kind: '__ready' }, 80);
  }

  override onReceive(msg: Cmd): void {
    if (msg.kind === '__ready') {
      this.data = { alice: 1, bob: 2 };
      this.ready = true;
      this.log.info('Repo warm — replaying stashed queries');
      this.context.unstashAll();
      return;
    }
    if (!this.ready) {
      this.log.info(`stashing ${msg.q} (${this.context.stashSize + 1} buffered)`);
      this.context.stash();
      return;
    }
    this.log.info(`${msg.q} → ${this.data[msg.q] ?? 'unknown'}`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('stash-demo');
  const repo = system.spawn(Props.create(() => new LoadingRepo()), 'repo');

  // Fire queries immediately; they pile up until the repo is warm.
  repo.tell({ kind: 'query', q: 'alice' });
  repo.tell({ kind: 'query', q: 'bob' });
  repo.tell({ kind: 'query', q: 'carol' });

  await new Promise(r => setTimeout(r, 200));
  await system.terminate();
}

void main();
