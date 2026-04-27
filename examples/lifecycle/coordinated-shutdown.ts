/**
 * Coordinated Shutdown example — register tasks across the canonical
 * phases and watch them fire in order on a SIGTERM or on an explicit
 * `cs.run()` call.
 *
 *   bun run examples/lifecycle/coordinated-shutdown.ts
 */
import {
  Actor,
  ActorSystem,
  CoordinatedShutdownId,
  Phases,
  Props,
  UnknownReason,
} from '../../src/index.js';

class Worker extends Actor<'tick'> {
  override preStart(): void {
    this.context.timers.startTimerWithFixedDelay('hb', 'tick', 50, 0);
  }
  override onReceive(_: 'tick'): void {
    this.log.info('heartbeat');
  }
  override postStop(): void {
    this.log.info('worker postStop — timers already cancelled for us');
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('cs-demo');
  const cs = system.extension(CoordinatedShutdownId);

  // Register tasks across several phases so the ordering becomes visible.
  cs.addTask(Phases.BeforeServiceUnbind, 'flush-http', async (reason) => {
    console.log(`[${reason.name}] 1. rejecting new HTTP traffic`);
  });
  cs.addTask(Phases.ServiceUnbind, 'close-http-listeners', async () => {
    console.log('2. closing HTTP listeners');
    await new Promise(r => setTimeout(r, 30));
  });
  cs.addTask(Phases.ServiceRequestsDone, 'drain-in-flight', async () => {
    console.log('3. waiting for in-flight requests');
    await new Promise(r => setTimeout(r, 20));
  });
  cs.addTask(Phases.ClusterLeave, 'leave-cluster', async () => {
    console.log('4. leaving cluster (noop — we have no cluster here)');
  });
  cs.addTask(Phases.BeforeActorSystemTerminate, 'release-external', async () => {
    console.log('5. closing DB pool, flushing metrics');
  });

  system.actorOf(Props.create(() => new Worker()), 'worker');
  await new Promise(r => setTimeout(r, 150));

  console.log('--- cs.run() ---');
  await cs.run(UnknownReason.instance);
  console.log('system terminated =', system.isTerminated);
}

void main();
