#!/usr/bin/env bun
/**
 * Panel-development harness.
 *
 * Boots a small actor system with DevTools attached and serves the UI
 * straight from the bundler's output directory, so the edit loop is
 * save → rebuild → refresh with no `tsc` run, no regeneration of the
 * embedded module, and no server restart.
 *
 *   bun run build:ui -- --dev --watch     # terminal 1: rebuild on save
 *   bun run dev:devtools                  # terminal 2: this harness
 *
 * The demo actors exist to give the panels something to show: a
 * supervised worker tree that keeps spawning, handling and stopping so
 * the tree, mailbox and lifecycle streams are never empty.
 */
import { Actor } from '../src/Actor.js';
import { ActorSystem } from '../src/ActorSystem.js';
import { Props } from '../src/Props.js';
import type { ActorRef } from '../src/ActorRef.js';
import { Cluster } from '../src/cluster/Cluster.js';
import { ClusterOptions } from '../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../src/cluster/Transport.js';
import { NodeAddress } from '../src/cluster/NodeAddress.js';
import { tracerOf } from '../src/tracing/TracingExtension.js';
import { PersistentActor } from '../src/persistence/PersistentActor.js';
import { DevTools } from '../src/devtools/DevTools.js';
import { DevToolsOptions } from '../src/devtools/DevToolsOptions.js';

type TickMessage = {
  readonly kind: 'tick';
  readonly index: number;
};

type WorkMessage = {
  readonly kind: 'work';
  readonly payload: string;
};

class WorkerActor extends Actor<WorkMessage> {
  override async onReceive(message: WorkMessage): Promise<void> {
    // A little variance so timing panels have something to plot.
    await new Promise((resolve) => setTimeout(resolve, 1 + Math.random() * 8));
    this.log.debug(`worked on ${message.payload}`);
  }
}

type DepositEvent = {
  readonly kind: 'deposited';
  readonly amount: number;
};

type LedgerState = {
  readonly balance: number;
  readonly deposits: number;
};

/** Gives the time-travel panel a journal with a growing history. */
class LedgerActor extends PersistentActor<WorkMessage, DepositEvent, LedgerState> {
  readonly persistenceId = 'ledger-1';
  initialState(): LedgerState { return { balance: 0, deposits: 0 }; }
  onEvent(state: LedgerState, event: DepositEvent): LedgerState {
    return { balance: state.balance + event.amount, deposits: state.deposits + 1 };
  }
  async onCommand(_state: LedgerState, _command: WorkMessage): Promise<void> {
    await this.persist({ kind: 'deposited', amount: 1 + Math.floor(Math.random() * 20) });
  }
}

class SupervisorActor extends Actor<TickMessage> {
  private index = 0;
  /** A short-lived child that has already been stopped. */
  private stoppedEphemeral: ActorRef<WorkMessage> | null = null;

  override async preStart(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      this.context.spawn(Props.create(() => new WorkerActor()), `worker-${i}`);
    }
    this.context.spawn(Props.create(() => new LedgerActor()), 'ledger');
    this.context.timers.startTimerWithFixedDelay('tick', { kind: 'tick', index: 0 }, 500, 500);
  }

  override onReceive(_message: TickMessage): void {
    this.index++;
    const workers = this.context.children.filter((child) => child.path.name.startsWith('worker-'));

    // Actors only open a span for a message that already belongs to a
    // trace, and nothing in the framework starts one — so the entry
    // point seeds it, exactly as an application would.
    const tracer = tracerOf(this.context.system);
    const root = tracer.startSpan('tick', { kind: 'server' });
    tracer.withActiveSpan(root, () => {
      for (const worker of workers) {
        worker.tell({ kind: 'work', payload: `job-${this.index}` } as never);
      }
    });
    root.end();

    // Every other tick, append to the journal so the time-travel panel
    // has a history that grows while you watch it.
    if (this.index % 2 === 0) {
      this.context.child('ledger').forEach((ledger) => {
        ledger.tell({ kind: 'work', payload: 'deposit' } as never);
      });
    }

    // Churn a short-lived child so the lifecycle counters, the tree and
    // their sparklines actually move; a static tree tells you nothing
    // about whether the panels are live.
    const ephemeral = this.context.spawn(
      Props.create(() => new WorkerActor()),
      `ephemeral-${this.index}`,
    );
    ephemeral.tell({ kind: 'work', payload: 'short-lived' } as never);
    this.context.system.scheduler.scheduleOnceFunction(300, () => {
      this.context.stop(ephemeral);
      // Remembered only AFTER stopping, so a message aimed at it later
      // really does land in dead letters — remembering it at spawn time
      // races the stop and usually finds the actor still alive.
      this.stoppedEphemeral = ephemeral;
    });

    // Every so often, post to an actor that is definitely gone: the
    // dead-letter counter and its spike chart need a real source.
    if (this.index % 5 === 0 && this.stoppedEphemeral !== null) {
      this.stoppedEphemeral.tell({ kind: 'work', payload: 'too late' } as never);
    }
  }
}

const system = ActorSystem.create('devtools-playground');
system.spawn(Props.create(() => new SupervisorActor()), 'supervisor');

// A single-node cluster over the in-memory transport, so the cluster
// panel has real membership to render without needing a second process.
const clusterOptions = ClusterOptions.create()
  .withHost('local')
  .withPort(1)
  .withTransport(new InMemoryTransport(new NodeAddress('devtools-playground', 'local', 1)));
const cluster = await Cluster.join(system, clusterOptions);

const devtoolsOptions = DevToolsOptions.create()
  .withPort(9333)
  .withCluster(cluster)
  .withUiDevelopmentRoot('devtools-ui/.dev');
const devtools = await DevTools.attach(system, devtoolsOptions);

console.log(`\nDevTools playground → ${devtools.url}\n`);
