import { describe, expect, test } from 'bun:test';
import { JournalError } from '../../../src/persistence/JournalTypes.js';
import { LazyStore } from '../../../src/persistence/LazyStore.js';

/**
 * `LazyStore` is the open every pool- or client-backed store inherits: the
 * relational family, MongoDB and DynamoDB.  Its memoization was written for
 * one property — concurrent first calls share one open — and it held that one
 * by remembering the open *forever*, failures included (#1473):
 *
 *   - a failed first open was handed to every later call, so one database
 *     blip at a store's first use failed every persist and every recovery on
 *     that node for the life of the process;
 *   - a `prepare()` (the DDL step) that failed after `openResource()` left the
 *     opened pool referenced by nothing, so not even `close()` released it;
 *   - a `close()` that arrived while an open was still in flight let the open
 *     finish afterwards, and the store came back holding a live resource.
 *
 * A boot-time warm-up is only safe once none of that holds, which is why these
 * cases come before `start()` does.  Every scenario below drives the open
 * through the same protected `ensureOpen` a real store's query methods call
 * first, against a resource that is just a labelled string.
 */

/** What a probe store did with its resources, in order. */
type Recorder = {
  readonly opened: string[];
  readonly prepared: string[];
  readonly released: string[];
};

type ProbeStoreOptions = {
  /** Whether the store opened the resource itself — see `LazyStoreConfig.ownsResource`. */
  readonly owns: boolean;
  /** Called on every open attempt with its 1-based attempt number. */
  readonly open: (attempt: number) => Promise<string>;
  /** The DDL step; resolves by default. */
  readonly prepare?: (resource: string) => Promise<void>;
};

class ProbeStore extends LazyStore<string> {
  readonly recorder: Recorder;
  private readonly prepareStep: (resource: string) => Promise<void>;

  constructor(options: ProbeStoreOptions) {
    // Built before `super()` because the open closure needs it and `this` does
    // not exist yet there.
    const recorder: Recorder = { opened: [], prepared: [], released: [] };
    let attempts = 0;
    super({
      storeName: 'ProbeStore',
      ownsResource: options.owns,
      openResource: async () => {
        attempts++;
        const resource = await options.open(attempts);
        recorder.opened.push(resource);
        return resource;
      },
    });
    this.recorder = recorder;
    this.prepareStep = options.prepare ?? (async () => { /* nothing to create */ });
  }

  protected async prepare(resource: string): Promise<void> {
    this.recorder.prepared.push(resource);
    await this.prepareStep(resource);
  }

  protected async release(resource: string): Promise<void> {
    this.recorder.released.push(resource);
  }

  /** The first operation's way into the open — what every query method of a real store calls first. */
  use(): Promise<string> {
    return this.ensureOpen();
  }
}

/** A promise the test settles by hand: how an open is held in flight without a timer. */
type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** The error `promise` rejects with; a resolution fails the test instead. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the call to reject, and it resolved');
}

describe('LazyStore — a failed open is not remembered (#1473)', () => {
  test('a failed first open is retried by the next call', async () => {
    const store = new ProbeStore({
      owns: true,
      open: async (attempt) => {
        if (attempt === 1) throw new Error('database not up yet');
        return `connection-${attempt}`;
      },
    });

    expect((await failureOf(store.use())).message).toBe('database not up yet');
    expect(await store.use()).toBe('connection-2');
    expect(store.recorder.opened).toEqual(['connection-2']);
    // Once open, the store stays open: a third call opens nothing.
    expect(await store.use()).toBe('connection-2');
    expect(store.recorder.prepared).toEqual(['connection-2']);
    await store.close();
  });

  test('callers that share a failing open share its one rejection, and the next call opens afresh', async () => {
    const opening = deferred<string>();
    let attempts = 0;
    const store = new ProbeStore({
      owns: true,
      open: async (attempt) => {
        attempts = attempt;
        if (attempt === 1) return opening.promise;
        return `connection-${attempt}`;
      },
    });

    const first = failureOf(store.use());
    const second = failureOf(store.use());
    opening.reject(new Error('connection refused'));
    expect((await first).message).toBe('connection refused');
    expect((await second).message).toBe('connection refused');
    expect(attempts).toBe(1);

    expect(await store.use()).toBe('connection-2');
    expect(attempts).toBe(2);
    await store.close();
  });

  test('a prepare() failure releases an owned resource exactly once, before the retry', async () => {
    const store = new ProbeStore({
      owns: true,
      open: async (attempt) => `connection-${attempt}`,
      prepare: async (resource) => {
        if (resource === 'connection-1') throw new Error('permission denied for schema public');
      },
    });

    expect((await failureOf(store.use())).message).toBe('permission denied for schema public');
    // Released before the rejection surfaced — the failed attempt holds nothing.
    expect(store.recorder.released).toEqual(['connection-1']);

    expect(await store.use()).toBe('connection-2');
    expect(store.recorder.released).toEqual(['connection-1']);

    await store.close();
    expect(store.recorder.released).toEqual(['connection-1', 'connection-2']);
  });

  test('an injected resource is never released, not even when its prepare() fails', async () => {
    const store = new ProbeStore({
      owns: false,
      open: async () => 'shared-pool',
      prepare: async () => {
        if (store.recorder.prepared.length === 1) throw new Error('permission denied for schema public');
      },
    });

    expect((await failureOf(store.use())).message).toBe('permission denied for schema public');
    expect(store.recorder.released).toEqual([]);
    expect(await store.use()).toBe('shared-pool');
    await store.close();
    expect(store.recorder.released).toEqual([]);
  });

  test('a release() that fails does not mask the open failure that caused it', async () => {
    class ReleaseFailsStore extends ProbeStore {
      protected override async release(resource: string): Promise<void> {
        await super.release(resource);
        throw new Error('pool already ended');
      }
    }
    const store = new ReleaseFailsStore({
      owns: true,
      open: async (attempt) => `connection-${attempt}`,
      prepare: async (resource) => {
        if (resource === 'connection-1') throw new Error('relation "events" already exists with another owner');
      },
    });

    expect((await failureOf(store.use())).message).toBe('relation "events" already exists with another owner');
    expect(store.recorder.released).toEqual(['connection-1']);
    expect(await store.use()).toBe('connection-2');
    await store.close();
  });
});

describe('LazyStore — one open at a time', () => {
  test('two concurrent first calls run one init', async () => {
    const opening = deferred<string>();
    const store = new ProbeStore({ owns: true, open: () => opening.promise });

    const first = store.use();
    const second = store.use();
    opening.resolve('connection-1');

    expect(await first).toBe('connection-1');
    expect(await second).toBe('connection-1');
    expect(store.recorder.opened).toEqual(['connection-1']);
    expect(store.recorder.prepared).toEqual(['connection-1']);
    await store.close();
  });
});

describe('LazyStore — close() racing an open (#1473)', () => {
  test('close() while openResource() is in flight leaves nothing open', async () => {
    const opening = deferred<string>();
    const store = new ProbeStore({ owns: true, open: () => opening.promise });

    const operation = failureOf(store.use());
    const closing = store.close();
    opening.resolve('connection-1');
    await closing;

    // A resolved close() means nothing is left open — asserted before the
    // operation's own rejection is awaited, so a close() that returns early
    // and leaves the release to the open cannot pass.  Released once, by the
    // open itself, and never prepared: no DDL against a closed store.
    expect(store.recorder.released).toEqual(['connection-1']);
    expect(store.recorder.prepared).toEqual([]);
    const failure = await operation;
    expect(failure).toBeInstanceOf(JournalError);
    expect(failure.message).toBe('ProbeStore is closed');
  });

  test('close() while prepare() is in flight releases the resource once the step settles', async () => {
    const preparing = deferred<void>();
    const prepareEntered = deferred<void>();
    const store = new ProbeStore({
      owns: true,
      open: async (attempt) => `connection-${attempt}`,
      prepare: () => {
        prepareEntered.resolve();
        return preparing.promise;
      },
    });

    const operation = failureOf(store.use());
    // Close only once the open has reached prepare().
    await prepareEntered.promise;
    const closing = store.close();
    preparing.resolve();
    await closing;

    expect(store.recorder.released).toEqual(['connection-1']);
    expect((await operation).message).toBe('ProbeStore is closed');
  });

  test('close() while an injected resource is being opened releases nothing', async () => {
    const opening = deferred<string>();
    const store = new ProbeStore({ owns: false, open: () => opening.promise });

    const operation = failureOf(store.use());
    const closing = store.close();
    opening.resolve('shared-pool');
    await closing;

    expect((await operation).message).toBe('ProbeStore is closed');
    expect(store.recorder.released).toEqual([]);
  });

  test('every call after close() rejects with the is-closed error and opens nothing', async () => {
    const store = new ProbeStore({ owns: true, open: async (attempt) => `connection-${attempt}` });
    await store.close();

    const failure = await failureOf(store.use());
    expect(failure).toBeInstanceOf(JournalError);
    expect(failure.message).toBe('ProbeStore is closed');
    expect(store.recorder.opened).toEqual([]);
  });
});
