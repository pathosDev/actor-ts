/**
 * The actor module the worker-mesh smoke case hands its mesh: every real
 * worker thread imports this file by URL on Bun, Node and Deno.
 *
 * It has to reach the framework the same way the runner does — `src/` on Bun,
 * `dist/` under `ACTOR_TS_SMOKE_USE_DIST=1` on Node and Deno — and the switch
 * the runner makes for itself is only visible here through the environment,
 * which every runtime's workers inherit.  A top-level `await` in a module the
 * bootstrap imports *after* its handshake is fine; the hazard `WorkerNode`
 * documents is a top-level await in the worker's entry module.
 */
const base = process.env.ACTOR_TS_SMOKE_USE_DIST === '1' ? '../../../dist/index.js' : '../../../src/index.ts';
const { Actor } = await import(base);

/** Answers with the address of the node it runs on — which must not be the main thread's. */
export class Where extends Actor {
  onReceive(command) {
    command.replyTo.tell(this.cluster.selfAddress.toString());
  }
}

export function setup(context) {
  context.system.spawn(Where, 'where');
}
