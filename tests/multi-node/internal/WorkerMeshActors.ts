/**
 * The actor module `tests/multi-node/WorkerMesh.test.ts` hands its mesh: every
 * real worker thread imports this file by URL, registers the classes it
 * exports by name, and runs `setup` once its node is up.
 *
 * Plain-data messages with a `kind` discriminant, because that is what
 * survives the structured clone a real thread boundary applies (#1386).
 */
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import type { WorkerMeshSetupContext } from '../../../src/worker/WorkerMeshBootstrap.js';

export type WhereCommand = { readonly kind: 'where'; readonly replyTo: ActorRef<string> };

/** Answers with the address of the node it runs on — the proof it is not on main. */
export class Where extends Actor<WhereCommand> {
  override onReceive(command: WhereCommand): void {
    command.replyTo.tell(this.cluster.selfAddress.toString());
  }
}

export function setup(context: WorkerMeshSetupContext): void {
  context.system.spawn(Where, 'where');
}
