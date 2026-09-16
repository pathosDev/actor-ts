/**
 * The actor module of the parallelism smoke case: the main thread imports it
 * for the export names, and every real worker thread imports it by URL on
 * Bun, Node and Deno.  Reaches the framework the way the runner does —
 * `src/` on Bun, `dist/` under `ACTOR_TS_SMOKE_USE_DIST=1` — through the
 * environment every runtime's workers inherit.
 */
const base = process.env.ACTOR_TS_SMOKE_USE_DIST === '1' ? '../../../dist/index.js' : '../../../src/index.ts';
const { Actor } = await import(base);

/** Answers with the address of the node it runs on — which must not be the main thread's. */
export class Where extends Actor {
  onReceive(command) {
    command.replyTo.tell(this.cluster.selfAddress.toString());
  }
}

/** Sums what it is sent, so a burst sent before the threads exist can be checked for completeness. */
export class Sum extends Actor {
  total = 0;
  onReceive(command) {
    if (command.kind === 'add') this.total += command.value;
    else command.replyTo.tell(this.total);
  }
}
