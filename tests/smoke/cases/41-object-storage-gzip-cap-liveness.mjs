/**
 * Smoke case: a gzip body round-trips through object storage on whichever
 * runtime is running, the decompression cap refuses an over-cap body BEFORE
 * its output is allocated, and — where the runtime's own `node:zlib` runs its
 * async forms off the thread — the store compresses without holding the event
 * loop (#1540).
 *
 * `Compression.ts` moved from `gzipSync` / `gunzipSync` to `zlib.gzip` /
 * `zlib.gunzip`.  Two things about that are runtime-sensitive, and neither is
 * something `bun test` can see:
 *
 *   - The cap.  `maxOutputLength` used to abort the SYNC call with
 *     `ERR_BUFFER_TOO_LARGE`; the promise-shaped translation in
 *     `decompressWithinCap` keys off that code arriving through the CALLBACK
 *     now, on three zlib implementations.  Measured to hold on all three; this
 *     case is what keeps it measured.
 *   - The liveness.  On Bun and Node the async forms run the deflate on the
 *     libuv pool and a 1 ms interval keeps firing across the call.  On Deno
 *     2.6 they defer the call and then run it as one main-thread block: the
 *     conversion is correct there and buys no liveness.  So the liveness half
 *     is gated on a CAPABILITY probe — raw `node:zlib` on a few MiB with an
 *     interval alive — and not on the runtime's name: a Deno that starts
 *     pooling its zlib starts being asserted on here without anyone editing a
 *     list, and a Bun or Node that stopped would go red.
 *
 * The liveness measurement runs over an in-memory backend written here, not
 * the filesystem one the round trip uses.  That is deliberate: a filesystem
 * `put` is itself async I/O that yields to timers, so a store over it ticks
 * at least once whether or not the compressor blocked, and the assertion would
 * be satisfied by the write rather than by the thing under test.  Over a
 * `Map`, the only thing in an `upsert` that can let a timer fire is the
 * compressor — run against the sync implementation this half reads exactly
 * zero ticks.
 */
export const name = 'object-storage gzip cap + liveness';
export const description = 'a gzip body round-trips and is refused over maxDecompressedBytes before allocation on every runtime; where node:zlib pools its async forms, the store compresses without holding the event loop';

// Large enough that its JSON envelope cannot fit under the tiny cap below,
// small enough to stay a cheap smoke case.  Highly compressible on purpose:
// the point of a cap is that the STORED size says nothing about the decoded
// size, so a few-KB object has to be assumed capable of any output.
const STATE_TEXT = 'the quick brown fox jumps over the lazy dog '.repeat(2000);
const TINY_CAP_BYTES = 1024;

/**
 * The liveness body: 16 MiB of a repeated 16 KiB pseudo-random hex block.
 * Real deflate work (the block itself has no internal repeats gzip's 32 KiB
 * window can use) that still finishes in tens of milliseconds at level 9 —
 * measured 40 ms on Bun 1.4.2 and 90 ms on Node 26 — which is long enough for
 * a 1 ms interval to land dozens of times, and short enough for a smoke case.
 * A repeated PANGRAM would not do: it compresses in a handful of milliseconds
 * and a real async call could legitimately see no tick at all.
 */
const LIVENESS_BLOCK_BYTES = 16 * 1024;
const LIVENESS_BODY_BYTES = 16 * 1024 * 1024;
const TICK_INTERVAL_MS = 1;

export async function run({ actorTs, loadEntry }) {
  const {
    FilesystemObjectStorageBackend,
    FilesystemObjectStorageOptions,
    ObjectStorageConcurrencyError,
    ObjectStorageDurableStateStore,
    ObjectStorageDurableStateStoreOptions,
  } = await loadEntry('persistence');
  const { some, none } = actorTs;
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'actor-ts-gzip-cap-'));
  const openStores = [];
  const storeOver = (backend, configure) => {
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'gzip', level: 9 });
    const store = new ObjectStorageDurableStateStore(configure ? configure(storeOptions) : storeOptions);
    openStores.push(store);
    return store;
  };
  const filesystemBackend = () => {
    const backendOptions = FilesystemObjectStorageOptions.create().withDir(directory);
    return new FilesystemObjectStorageBackend(backendOptions);
  };

  try {
    // --- Round trip and cap: every runtime, the filesystem backend. ---
    await storeOver(filesystemBackend()).upsert('cap-probe', 0, { note: STATE_TEXT });

    const loaded = await storeOver(filesystemBackend()).load('cap-probe');
    assert(!loaded.isNone(), 'the stored gzip body did not read back');
    assert(
      loaded.value.state.note === STATE_TEXT,
      'the gzip body read back with different content than was written',
    );

    const capped = await failureOf(
      () => storeOver(filesystemBackend(), (options) => options.withMaxDecompressedBytes(TINY_CAP_BYTES)).load('cap-probe'),
    );
    assert(capped !== undefined, 'a body far over maxDecompressedBytes decoded without complaint');
    const capText = messageChain(capped);
    assert(
      new RegExp(`maxOutputBytes=${TINY_CAP_BYTES}`).test(capText),
      `the cap failure never mentions the bound that caused it: ${capText}`,
    );
    // The distinguishing half: an over-cap read fails whether the bound is
    // handed to the decoder or applied to its finished output, so only this
    // tail separates refusing the bomb from decoding it and then objecting.
    // It is also the half the async conversion could have lost — the abort
    // now travels through zlib's callback as an error object, and this is
    // where "its `code` survived" is checked on this runtime.
    assert(
      /aborted before the output was allocated/.test(capText),
      `the cap was applied only after the output was materialised: ${capText}`,
    );

    // --- Liveness: by capability, over the in-memory backend. ---
    const body = livenessBody();
    const rawProbe = await ticksDuring(() => rawAsyncGzip(body));
    if (rawProbe.ticks === 0) {
      // This runtime's own `node:zlib` holds the thread for its async forms
      // (Deno 2.6 does — measured, and documented in
      // docs/…/fundamentals/blocking-and-cpu-bound-work.mdx).  Nothing the
      // store does can be more live than the API underneath it, so the
      // assertion below would be red for a reason that is not the store's.
      // The round trip and the cap above ran; only this half is skipped.
      console.log(
        `  ↷ liveness assertion skipped: this runtime's async node:zlib ran ${rawProbe.elapsedMs.toFixed(0)} ms `
        + 'of gzip on the main thread (0 ticks), so the store cannot be asserted freer than its zlib',
      );
      return;
    }

    const memoryStore = storeOver(new InMemoryObjectStorageBackend({ some, none, ObjectStorageConcurrencyError }));
    const reading = await ticksDuring(() => memoryStore.upsert('liveness-probe', 0, { note: body }));
    assert(
      reading.ticks >= 1,
      `no timer tick landed in the ${reading.elapsedMs.toFixed(0)} ms the store took to compress ${LIVENESS_BODY_BYTES} `
      + `bytes, while raw node:zlib ticked ${rawProbe.ticks} times on the same body: the store is holding the event loop`,
    );
    assert(
      reading.ticksInSecondHalf >= 1,
      `${reading.ticks} tick(s) landed while the store compressed, all in the first half of its `
      + `${reading.elapsedMs.toFixed(0)} ms: the compressor defers itself and then blocks, which is a *Sync call behind an await`,
    );
  } finally {
    for (const store of openStores) {
      try { await store.close(); } catch { /* teardown is best-effort */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The smallest `ObjectStorageBackend` that satisfies the store: PUT / GET /
 * DELETE / LIST over a `Map`, with the two CAS options honoured because the
 * store relies on `ifNoneMatch: '*'` for a first write.  Everything here
 * settles in a microtask — no I/O, no timer — which is the property the
 * liveness measurement needs (see the header).
 */
class InMemoryObjectStorageBackend {
  constructor({ some, none, ObjectStorageConcurrencyError }) {
    this.some = some;
    this.none = none;
    this.ObjectStorageConcurrencyError = ObjectStorageConcurrencyError;
    this.objects = new Map();
    this.revision = 0;
  }

  async put(key, body, options = {}) {
    const existing = this.objects.get(key);
    if (options.ifNoneMatch === '*' && existing !== undefined) throw new this.ObjectStorageConcurrencyError(key);
    if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) throw new this.ObjectStorageConcurrencyError(key);
    const etag = `"${++this.revision}"`;
    this.objects.set(key, {
      body: body.slice(),
      etag,
      lastModified: new Date(),
      contentType: options.contentType,
      contentEncoding: options.contentEncoding,
    });
    return { etag };
  }

  async get(key) {
    const object = this.objects.get(key);
    return object === undefined ? this.none : this.some({ ...object, body: object.body.slice() });
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list({ prefix, limit }) {
    const infos = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, object]) => ({ key, size: object.body.length, lastModified: object.lastModified }));
    return limit === undefined ? infos : infos.slice(0, limit);
  }
}

/** Run `work` with a 1 ms interval alive across it and count how often, and when, the loop turned. */
async function ticksDuring(work) {
  const tickTimesMs = [];
  const started = performance.now();
  const interval = setInterval(() => { tickTimesMs.push(performance.now() - started); }, TICK_INTERVAL_MS);
  try {
    await work();
  } finally {
    // On every path: an interval left running keeps Deno's loop alive past
    // the runner's 15 s watchdog, and the run then hangs after its last green
    // line (#1196).
    clearInterval(interval);
  }
  const elapsedMs = performance.now() - started;
  return {
    ticks: tickTimesMs.length,
    ticksInSecondHalf: tickTimesMs.filter((at) => at >= elapsedMs / 2).length,
    elapsedMs,
  };
}

/** The runtime's own async gzip, options object spelled out — the shape `Compression.ts` uses. */
async function rawAsyncGzip(text) {
  const zlib = await import('node:zlib');
  const input = new TextEncoder().encode(text);
  return new Promise((resolve, reject) => {
    zlib.gzip(input, { level: 9 }, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

/** See {@link LIVENESS_BODY_BYTES}. `Math.imul` keeps the generator in 32 bits; a plain `*` collapses it. */
function livenessBody() {
  const digits = '0123456789abcdef';
  let seed = 0x9e3779b9;
  let block = '';
  for (let index = 0; index < LIVENESS_BLOCK_BYTES; index++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    block += digits[seed >>> 28];
  }
  return block.repeat(LIVENESS_BODY_BYTES / LIVENESS_BLOCK_BYTES);
}

/** Run `attempt` and hand back the error it threw, or `undefined` when it succeeded. */
async function failureOf(attempt) {
  try {
    await attempt();
    return undefined;
  } catch (e) {
    return e;
  }
}

/**
 * Both stores hand a decode failure onward differently — one re-throws it,
 * the other wraps it in a `JournalError` whose own message says "integrity /
 * decode failure" — so the sentence that names the cap can be one or two
 * levels down.  Flatten the chain and match against the whole thing.
 */
function messageChain(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current.cause;
  }
  return parts.join(' | ');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
