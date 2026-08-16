/**
 * Realistic ActorSelection: a dispatcher looks up named workers by path
 * based on a route table loaded from configuration — no direct ActorRefs
 * passed around, so workers can be added/removed without touching the
 * dispatcher's wiring.
 *
 *   bun run examples/selection/lookup-named-workers.ts
 */
import { Actor, ActorSystem } from '../../src/index.js';

type Job = { readonly kind: string; readonly payload: unknown; };

class ImageWorker extends Actor<Job> {
  override onReceive(job: Job): void { console.log(`[images] job kind=${job.kind}`, job.payload); }
}
class EmailWorker extends Actor<Job> {
  override onReceive(job: Job): void { console.log(`[email] job kind=${job.kind}`, job.payload); }
}
class AuditWorker extends Actor<Job> {
  override onReceive(job: Job): void { console.log(`[audit] job kind=${job.kind}`, job.payload); }
}

// Route-table style configuration: { kind -> actor-path }.
const ROUTES: Record<string, string> = {
  resize: '/user/workers/images',
  'send-email': '/user/workers/email',
  'write-audit': '/user/workers/audit',
};

class Dispatcher extends Actor<Job> {
  override onReceive(job: Job): void {
    const path = ROUTES[job.kind];
    if (!path) { console.warn(`no worker registered for kind=${job.kind}`); return; }
    this.context.actorSelection(path).tell(job);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('selection-realistic');

  // Spawn workers under a shared "workers" parent so the path prefix is stable.
  class WorkersRoot extends Actor<never> {
    override preStart(): void {
      this.context.spawn(ImageWorker, 'images');
      this.context.spawn(EmailWorker, 'email');
      this.context.spawn(AuditWorker, 'audit');
    }
    override onReceive(): void {}
  }
  system.spawn(WorkersRoot, 'workers');
  const dispatcher = system.spawn(Dispatcher, 'dispatcher');

  // Not a drain sleep — the drain only runs inside terminate(), and this is
  // about *creation*: WorkersRoot's `preStart` is what spawns the three
  // workers, on its own dispatcher tick.  Deleting it happens to still work,
  // because the guardian runs the two `create`s in spawn order, but that is
  // cross-cell scheduling order rather than a guarantee the way one mailbox's
  // FIFO is.  Kept so the routes cannot resolve to nothing and dead-letter.
  await Bun.sleep(20);

  dispatcher.tell({ kind: 'resize', payload: { file: 'avatar.png', width: 256 } });
  dispatcher.tell({ kind: 'send-email', payload: { to: 'alice@example.com', subject: 'Welcome' } });
  dispatcher.tell({ kind: 'write-audit', payload: { actor: 'alice', action: 'signup' } });
  dispatcher.tell({ kind: 'unknown', payload: null });

  // No sleep: a selection resolves and tells synchronously inside the
  // dispatcher's own turn, so each worker is already marked busy when the
  // drain looks — it follows the fan-out rather than flushing one mailbox.
  await system.terminate();
}

void main();
