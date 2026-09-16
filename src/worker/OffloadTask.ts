/**
 * What an offloaded task *is*, and the frames that carry one to a worker
 * and its result back (#1558).
 *
 * A function cannot cross a thread, so a task is named rather than passed:
 * the URL of a module and the name of an export in it.  Both sides import
 * the module — the worker to run the export, the caller only to write the
 * URL — and the worker caches what it imported, so a task costs its module
 * once per worker and a clone of its arguments per run.
 */

/** A named export of a module, typed with the arguments it takes and the result it returns. */
export type OffloadTask<TArgs extends readonly unknown[] = readonly unknown[], TResult = unknown> = {
  readonly kind: 'offload-task';
  /** `href` of the module — absolute, because the worker resolves nothing relative to the caller. */
  readonly module: string;
  readonly exportName: string;
  /** Carries the type parameters through inference; never set.  A property, not a function, so the task stays covariant in both. */
  readonly __types?: { readonly args: TArgs; readonly result: TResult };
};

/**
 * Name a task.  Resolve the module against the caller, as in
 * `defineOffloadTask(new URL('./hash.js', import.meta.url), 'hashPassword')`;
 * a bundler that inlines modules is the one environment this does not
 * survive, and the docs say so.  The type parameters are what `pool.run`
 * checks the arguments and the result against.
 */
export function defineOffloadTask<TArgs extends readonly unknown[], TResult>(
  module: URL | string,
  exportName: string,
): OffloadTask<TArgs, TResult> {
  const href = module instanceof URL ? module.href : new URL(module).href;
  if (exportName.length === 0) throw new Error('defineOffloadTask: the export name must not be empty');
  return { kind: 'offload-task', module: href, exportName };
}

/** Main → worker: run one task. */
export type OffloadRunMessage = {
  readonly kind: 'offload-run';
  readonly id: number;
  readonly module: string;
  readonly exportName: string;
  readonly args: readonly unknown[];
};

/** Worker → main: the task returned. */
export type OffloadResultMessage = {
  readonly kind: 'offload-result';
  readonly id: number;
  readonly result: unknown;
};

/** Worker → main: the task threw, or could not be found; an `Error` is data by the time it crosses. */
export type OffloadErrorMessage = {
  readonly kind: 'offload-error';
  readonly id: number;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
};

/** Worker → main, once: the bootstrap is up and listening. */
export type OffloadReadyMessage = {
  readonly kind: 'offload-ready';
};

export type OffloadWireMessage = OffloadRunMessage | OffloadResultMessage | OffloadErrorMessage | OffloadReadyMessage;

/** The task threw on the worker; `name`, `message` and `stack` are the worker's, the instance is this thread's. */
export class OffloadTaskError extends Error {
  constructor(
    readonly task: string,
    readonly remoteName: string,
    message: string,
    readonly remoteStack: string | undefined,
  ) {
    super(`offloaded task ${task} threw ${remoteName}: ${message}`);
    this.name = 'OffloadTaskError';
  }
}

/** The queue is full and `overflow` is `reject`. */
export class OffloadQueueFullError extends Error {
  constructor(readonly task: string, readonly maxQueue: number) {
    super(`offloaded task ${task} rejected: the queue holds ${maxQueue} tasks already (overflow = reject)`);
    this.name = 'OffloadQueueFullError';
  }
}

/** The task ran past its deadline; the worker that ran it was terminated. */
export class OffloadTimeoutError extends Error {
  constructor(readonly task: string, readonly timeoutMs: number) {
    super(`offloaded task ${task} did not finish within ${timeoutMs} ms; its worker was terminated`);
    this.name = 'OffloadTimeoutError';
  }
}

/** The caller's `signal` aborted the run — before it was dispatched, or while it ran (the worker was terminated). */
export class OffloadAbortedError extends Error {
  constructor(readonly task: string, readonly reason: unknown) {
    super(`offloaded task ${task} was aborted${reason instanceof Error ? `: ${reason.message}` : ''}`);
    this.name = 'OffloadAbortedError';
  }
}

/** The worker running the task went away — a crash, or the pool terminating. */
export class OffloadWorkerLostError extends Error {
  constructor(readonly task: string, detail: string) {
    super(`offloaded task ${task} was lost: ${detail}`);
    this.name = 'OffloadWorkerLostError';
  }
}

/** The pool is closed, or has spent its restart budget and will spawn no worker again. */
export class OffloadPoolUnavailableError extends Error {
  constructor(detail: string) {
    super(`the offload pool is unavailable: ${detail}`);
    this.name = 'OffloadPoolUnavailableError';
  }
}
