/**
 * The whole reactive layer of the DevTools UI, in about sixty lines.
 *
 * Dependencies are passed explicitly rather than auto-tracked.  An
 * auto-tracking implementation is nicer to write against but needs a
 * dependency stack, ownership scopes and cleanup rules — real
 * complexity to debug inside a debugging tool.  Naming the inputs is a
 * small cost at each call site and removes that whole class of bug.
 */

/** A value others can observe. */
export interface ReadonlySignal<T> {
  get(): T;
  /** Observe changes.  Returns the unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
}

/** A value others can observe and anyone can write. */
export interface Signal<T> extends ReadonlySignal<T> {
  set(value: T): void;
  update(change: (current: T) => T): void;
}

/** Create a writable signal. */
export function signal<T>(initial: T): Signal<T> {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    set(value: T): void {
      if (Object.is(value, current)) return;
      current = value;
      // Copy before iterating: a listener may unsubscribe itself.
      for (const listener of [...listeners]) listener(current);
    },
    update(change: (current: T) => T): void {
      this.set(change(current));
    },
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A signal derived from others, recomputed whenever a dependency changes. */
export function computed<T>(
  compute: () => T,
  dependencies: ReadonlyArray<ReadonlySignal<unknown>>,
): ReadonlySignal<T> {
  const derived = signal(compute());
  for (const dependency of dependencies) {
    dependency.subscribe(() => derived.set(compute()));
  }
  return { get: derived.get, subscribe: derived.subscribe };
}

/**
 * Run `run` now and again on every dependency change.  Returns a
 * disposer that detaches from all of them — panels call it on unmount
 * so a hidden panel stops reacting.
 */
export function effect(
  run: () => void,
  dependencies: ReadonlyArray<ReadonlySignal<unknown>>,
): () => void {
  const disposers = dependencies.map((dependency) => dependency.subscribe(() => run()));
  run();
  return () => {
    for (const dispose of disposers) dispose();
  };
}
