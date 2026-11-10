import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ClusterMailboxDepthAgent } from '../../../../src/cluster/router/MailboxDepthAgent.js';
import type { WorkerMeshSetupContext } from '../../../../src/worker/WorkerMeshBootstrap.js';

/**
 * The actor module of the ClusterRouter-over-the-mesh recipe (#170), as the
 * routing docs print it — `routing/overview.mdx`, "Routers are not (the only)
 * way to parallelize".  `ClusterRouterOverMesh.test.ts` holds the two to the
 * same lines, so a recipe a reader copies is one this suite has run.
 *
 * A real file for the reason `actors.ts` beside it is one: the main thread
 * imports it to learn each class's export name, and the in-process rig imports
 * the same file for its fake workers.
 */

export type EncodeCommand = {
  readonly kind: 'encode';
  readonly frame: Uint8Array;
  readonly replyTo: ActorRef<EncodedFrame>;
};

export type EncodedFrame = {
  readonly bytes: number;
  /** The address of the node that did the work: which thread, in a mesh. */
  readonly encodedOn: string;
};

export class Encoder extends Actor<EncodeCommand> {
  override onReceive(command: EncodeCommand): void {
    // The CPU work goes here; the reply names the thread that did it.
    const encodedOn = this.system.cluster.map((cluster) => cluster.selfAddress.toString()).getOrElse('main');
    command.replyTo.tell({ bytes: command.frame.byteLength, encodedOn });
  }
}

/** Runs once on every worker, after its node has joined the mesh. */
export function setup(context: WorkerMeshSetupContext): void {
  context.system.spawn(Encoder, 'encoder');
  ClusterMailboxDepthAgent.serve(context.cluster);   // only 'smallest-mailbox' reads it
}
