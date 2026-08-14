/**
 * Smoke case: the object-storage decompression cap is a real bound on zstd
 * bodies, on whichever runtime is running — and a runtime that cannot do zstd
 * at all says so in words instead of dying inside a native binding (#580).
 *
 * This is runtime-sensitive in the strict sense: the cap is enforced by
 * whichever zstd implementation the resolver picked, and the resolver picks
 * differently per runtime.  Bun has two — its own `Bun.zstdDecompressSync`,
 * which takes no options and materialises the whole frame, and the `node:zlib`
 * shim, which honours `maxOutputLength` — so on Bun the fix is entirely a
 * question of WHICH one gets chosen.  A unit test on Bun cannot see that
 * choice being made anywhere else, and the unit suite never runs on Deno,
 * where `node:zlib` exports a `zstdDecompressSync` whose binding is missing;
 * a resolver that trusted the symbol's presence returned that broken function
 * and left the documented `fzstd` fallback unreachable beneath it.
 *
 * The case adapts to the runtime by CAPABILITY rather than by name: it writes
 * a zstd body and lets the write's own outcome decide which guarantee is
 * checked.  That way a future Deno with working zstd starts exercising the cap
 * here without anyone editing a runtime list.
 */
export const name = 'object-storage zstd cap';
export const description = 'a zstd body over maxDecompressedBytes is refused before its output is allocated, and a runtime without zstd fails clearly';

// Large enough that its JSON envelope cannot fit under the tiny cap below,
// small enough to stay a cheap smoke case.  Highly compressible on purpose:
// the point of a cap is that the STORED size says nothing about the decoded
// size, so a few-KB object has to be assumed capable of any output.
const STATE_TEXT = 'the quick brown fox jumps over the lazy dog '.repeat(2000);
const TINY_CAP_BYTES = 1024;

export async function run({ actorTs }) {
  const {
    FilesystemObjectStorageBackend,
    FilesystemObjectStorageOptions,
    ObjectStorageDurableStateStore,
    ObjectStorageDurableStateStoreOptions,
  } = actorTs;
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'actor-ts-zstd-cap-'));
  const openStores = [];
  const storeOver = (configure) => {
    const backendOptions = FilesystemObjectStorageOptions.create().withDir(directory);
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(new FilesystemObjectStorageBackend(backendOptions))
      .withCompression({ algorithm: 'zstd' });
    const store = new ObjectStorageDurableStateStore(configure ? configure(storeOptions) : storeOptions);
    openStores.push(store);
    return store;
  };

  try {
    const writeError = await failureOf(() => storeOver().upsert('cap-probe', 0, { note: STATE_TEXT }));

    if (writeError) {
      // No native zstd here.  The contract for that runtime is a sentence an
      // operator can act on — the name of the missing capability and what to
      // do instead — never a native binding's own error, which is what leaks
      // out of a resolver that checks a symbol is present instead of calling
      // it.
      const text = messageChain(writeError);
      assert(
        !/is not a constructor/.test(text),
        `a zstd write failed with a raw native error instead of the framework's: ${text}`,
      );
      assert(
        /zstd (compression|decompression)/.test(text) && /gzip|fzstd/.test(text),
        `a zstd write failed without naming zstd and a way forward: ${text}`,
      );
      return;
    }

    // Native zstd is available, so the cap is the thing under test.
    const capped = await failureOf(
      () => storeOver((options) => options.withMaxDecompressedBytes(TINY_CAP_BYTES)).load('cap-probe'),
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
    assert(
      /aborted before the output was allocated/.test(capText),
      `the cap was applied only after the output was materialised: ${capText}`,
    );

    // And the cap is a bound, not a blanket refusal — the same body reads back
    // whole once the bound admits it.
    const loaded = await storeOver().load('cap-probe');
    assert(!loaded.isNone(), 'the stored zstd body did not read back');
    assert(
      loaded.value.state.note === STATE_TEXT,
      'the zstd body read back with different content than was written',
    );
  } finally {
    for (const store of openStores) {
      try { await store.close(); } catch { /* teardown is best-effort */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
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
