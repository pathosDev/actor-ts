/**
 * Helper for worker-count-scaling.ts — runs inside each spawned Bun
 * Worker.  Receives `{ kind: 'crunch', n }` messages, burns N arithmetic
 * cycles, and replies `{ kind: 'done' }`.  No actor system, no cluster —
 * just raw postMessage plumbing so the benchmark measures the worker
 * channel itself, not framework overhead.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
interface Crunch { kind: 'crunch'; iterations: number; id: number }
interface Done { kind: 'done'; id: number }

declare const self: {
  onmessage: ((ev: { data: Crunch }) => void) | null;
  postMessage(v: unknown): void;
};

self.onmessage = (ev) => {
  const message = ev.data;
  if (message.kind !== 'crunch') return;
  let acc = 0;
  // A tight, branch-heavy loop — meaningful CPU work that the JIT can't
  // fold away (acc keeps it live, the result is returned with the reply).
  for (let i = 0; i < message.iterations; i++) {
    acc = (acc + (i * 2654435761)) | 0;
    acc = ((acc << 5) | (acc >>> 27)) ^ i;
  }
  const reply: Done & { acc: number } = { kind: 'done', id: message.id, acc };
  self.postMessage(reply);
};
