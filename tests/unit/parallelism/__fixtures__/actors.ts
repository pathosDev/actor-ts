import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import type { WorkerMeshSetupContext } from '../../../../src/worker/WorkerMeshBootstrap.js';

/**
 * The actor module of the parallelism suites (#1563).  A real file, because
 * the main thread imports it with a real `import()` to learn each class's
 * export name — and the in-process rig imports the same file for its fake
 * workers, so both sides share one module instance and the arrays below are
 * readable from the test.
 */

export type WhereCommand = { readonly kind: 'where'; readonly replyTo: ActorRef<string> };

/**
 * Replies with the address of the node it runs on — the whole question of
 * placement.  `no-cluster` when there is none yet: a main-thread actor can be
 * asked before the mesh has joined.
 */
export class Where extends Actor<WhereCommand> {
  override onReceive(command: WhereCommand): void {
    command.replyTo.tell(this.system.cluster.map((cluster) => cluster.selfAddress.toString()).getOrElse('no-cluster'));
  }
}

export type CounterCommand =
  | { readonly kind: 'add'; readonly value: number }
  | { readonly kind: 'total'; readonly replyTo: ActorRef<{ readonly total: number; readonly order: number[] }> };

/** Sums what it is sent and remembers the order, so buffering can be checked for ordering. */
export class Counter extends Actor<CounterCommand> {
  private total = 0;
  private readonly order: number[] = [];
  override onReceive(command: CounterCommand): void {
    if (command.kind === 'add') {
      this.total += command.value;
      this.order.push(command.value);
    } else {
      command.replyTo.tell({ total: this.total, order: [...this.order] });
    }
  }
}

export type EchoCommand = { readonly kind: 'echo'; readonly text: string; readonly replyTo: ActorRef<string> };

export class Echo extends Actor<EchoCommand> {
  override onReceive(command: EchoCommand): void {
    command.replyTo.tell(`${this.context.self.path.toString()} says ${command.text}`);
  }
}

/** Every `postStop` any `Lifecycle` ran, by path — shared with the test because the rig is in-process. */
export const stopped: string[] = [];

export class Lifecycle extends Actor<never> {
  override onReceive(): void { /* nothing */ }
  override postStop(): void { stopped.push(this.context.self.path.toString()); }
}

/** Not exported as an actor the mesh can name: the class the "unexported" cases spawn. */
export class Registered extends Actor<never> {
  override onReceive(): void { /* nothing */ }
}

export const NOT_AN_ACTOR = 42;

/** What every worker's `setup` saw, for the tests that ask where the setup ran. */
export const setups: string[] = [];

export function setup(context: WorkerMeshSetupContext): void {
  setups.push(context.selfAddress.toString());
}
