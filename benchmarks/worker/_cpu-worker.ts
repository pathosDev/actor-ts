/**
 * Helper for worker-count-scaling.ts and task-offload-breakeven.ts — runs
 * inside each spawned worker.  Receives `{ kind: 'crunch', iterations, id }`
 * messages, burns that many arithmetic cycles through the shared `crunch`
 * loop, and replies `{ kind: 'done', id, acc }`.  No actor system, no
 * cluster — just raw postMessage plumbing so the benchmark measures the
 * worker channel itself, not framework overhead.
 *
 * The loop body is imported rather than written here so the main-thread
 * baseline in task-offload-breakeven.ts runs identical code — see
 * `_crunch.ts`.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
import { crunch } from './_crunch.js';

type Crunch = { kind: 'crunch'; iterations: number; id: number };
type Done = { kind: 'done'; id: number };

/**
 * The dedicated-worker scope, reached through `globalThis` rather than a
 * `declare const self` — the latter collides with the DOM lib's own `self`
 * (TS2451) as soon as anything typechecks this file with `"lib": ["DOM"]`.
 */
const workerScope = globalThis as unknown as {
  onmessage: ((ev: { data: Crunch }) => void) | null;
  postMessage(v: unknown): void;
};

workerScope.onmessage = (ev) => {
  const message = ev.data;
  if (message.kind !== 'crunch') return;
  const acc = crunch(message.iterations);
  const reply: Done & { acc: number } = { kind: 'done', id: message.id, acc };
  workerScope.postMessage(reply);
};
