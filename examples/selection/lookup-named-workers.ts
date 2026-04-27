/**
 * Realistic ActorSelection: a dispatcher looks up named workers by path
 * based on a route table loaded from configuration — no direct ActorRefs
 * passed around, so workers can be added/removed without touching the
 * dispatcher's wiring.
 *
 *   bun run examples/selection/lookup-named-workers.ts
 */
import { Actor, ActorSystem, Props } from '../../src/index.js';

interface Job { readonly kind: string; readonly payload: unknown; }

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
      this.context.actorOf(Props.create(() => new ImageWorker()), 'images');
      this.context.actorOf(Props.create(() => new EmailWorker()), 'email');
      this.context.actorOf(Props.create(() => new AuditWorker()), 'audit');
    }
    override onReceive(): void {}
  }
  system.actorOf(Props.create(() => new WorkersRoot()), 'workers');
  const dispatcher = system.actorOf(Props.create(() => new Dispatcher()), 'dispatcher');

  // Let the workers finish preStart (they were spawned asynchronously).
  await Bun.sleep(20);

  dispatcher.tell({ kind: 'resize', payload: { file: 'avatar.png', width: 256 } });
  dispatcher.tell({ kind: 'send-email', payload: { to: 'alice@example.com', subject: 'Welcome' } });
  dispatcher.tell({ kind: 'write-audit', payload: { actor: 'alice', action: 'signup' } });
  dispatcher.tell({ kind: 'unknown', payload: null });

  await Bun.sleep(40);
  await system.terminate();
}

void main();
