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
import { DevTools } from '../src/devtools/DevTools.js';
import { DevToolsOptions } from '../src/devtools/DevToolsOptions.js';

interface TickMessage {
  readonly kind: 'tick';
  readonly index: number;
}

interface WorkMessage {
  readonly kind: 'work';
  readonly payload: string;
}

class WorkerActor extends Actor<WorkMessage> {
  override async onReceive(message: WorkMessage): Promise<void> {
    // A little variance so timing panels have something to plot.
    await new Promise((resolve) => setTimeout(resolve, 1 + Math.random() * 8));
    this.log.debug(`worked on ${message.payload}`);
  }
}

class SupervisorActor extends Actor<TickMessage> {
  private index = 0;

  override async preStart(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      this.context.spawn(Props.create(() => new WorkerActor()), `worker-${i}`);
    }
    this.context.timers.startTimerWithFixedDelay('tick', { kind: 'tick', index: 0 }, 500, 500);
  }

  override onReceive(_message: TickMessage): void {
    const workers = this.context.children;
    if (workers.length === 0) return;
    const target = workers[this.index++ % workers.length];
    target?.tell({ kind: 'work', payload: `job-${this.index}` } as never);
  }
}

const system = ActorSystem.create('devtools-playground');
system.spawn(Props.create(() => new SupervisorActor()), 'supervisor');

const devtoolsOptions = DevToolsOptions.create()
  .withPort(9333)
  .withUiDevelopmentRoot('devtools-ui/.dev');
const devtools = await DevTools.attach(system, devtoolsOptions);

console.log(`\nDevTools playground → ${devtools.url}\n`);
