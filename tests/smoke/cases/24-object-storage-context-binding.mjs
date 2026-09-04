/**
 * Smoke case: a stored body is bound to the storage key it lives at, on
 * whichever runtime is running (#612).
 *
 * This is runtime-sensitive in a way a unit test on Bun cannot cover.
 * The binding rides on two WebCrypto features that each runtime
 * implements against a different backend — Bun on BoringSSL, Node on
 * OpenSSL, Deno on its own Rust stack — and the failure mode is silent
 * rather than loud: a `subtle.encrypt` that ACCEPTS `additionalData`
 * and then ignores it produces a body that decrypts under any key at
 * all, and every assertion about round-tripping still passes.  Nothing
 * distinguishes that from a working binding except deliberately
 * decrypting under the wrong AAD and requiring it to fail.
 *
 * So the case checks the primitive first, directly against the
 * runtime's own `crypto.subtle`, and only then the property the stores
 * are built on: one persistenceId's authentic body, copied byte for
 * byte onto another persistenceId's key, must not read back.
 */
export const name = 'object-storage context binding';
export const description = 'AES-GCM additional-authenticated-data is honoured by this runtime, and a body replayed onto another storage key is refused';

const MASTER_KEY = new Uint8Array(32).fill(9);
const INTEGRITY_KEY = new Uint8Array(32).fill(7);
/** HKDF context — required on every client-side encryption config (#108). */
const HKDF_INFO = 'actor-ts/smoke/context-binding/v1';

export async function run({ actorTs, loadEntry }) {
  void actorTs;
  await assertRuntimeHonoursAdditionalData();

  const {
    FilesystemObjectStorageBackend,
    FilesystemObjectStorageOptions,
    ObjectStorageDurableStateStore,
    ObjectStorageDurableStateStoreOptions,
  } = await loadEntry('persistence');
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'actor-ts-context-binding-'));
  const openStores = [];
  const storeOver = (configure) => {
    const backendOptions = FilesystemObjectStorageOptions.create().withDir(directory);
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(new FilesystemObjectStorageBackend(backendOptions))
      .withCompression({ algorithm: 'none' })
      .withEncryption({ mode: 'client-aes256-gcm', masterKey: MASTER_KEY, info: HKDF_INFO })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(configure ? configure(storeOptions) : storeOptions);
    openStores.push(store);
    return store;
  };

  try {
    const store = storeOver();
    await store.upsert('alice', 0, { balance: 1000000 });
    await store.upsert('bob', 0, { balance: 1 });

    // The ordinary path has to keep working, or "refuses everything" would
    // pass the test below for the wrong reason.
    const bob = await store.load('bob');
    assert(!bob.isNone(), 'a freshly written record did not read back');
    assert(bob.value.state.balance === 1, 'a record read back with different content than was written');

    // Both records sit at revision 1, so the in-process rollback floor
    // has nothing to say here — the key binding is the only thing that
    // can catch this.
    // `state/` is the namespace the durable-state store owns under its
    // prefix (#716) — the FS backend stores each key at `dir/<key>` 1:1.
    const bodyFileFor = (persistenceId) => join(directory, 'state', persistenceId, 'state.json');
    const aliceBody = await readFile(bodyFileFor('alice'));
    await writeFile(bodyFileFor('bob'), aliceBody);

    store.forgetEtagForTest('bob');
    const replay = await failureOf(() => store.load('bob'));
    assert(
      replay !== undefined,
      "one persistenceId's body read back cleanly under another's key — nothing binds the storage key on this runtime",
    );
    assert(
      /integrity \/ decode failure/.test(messageChain(replay)),
      `the replay was refused, but not by the codec: ${messageChain(replay)}`,
    );
  } finally {
    for (const store of openStores) {
      try { await store.close(); } catch { /* teardown is best-effort */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The primitive, straight against the runtime.  A `subtle` that quietly
 * drops `additionalData` would let every higher-level assertion pass
 * while binding nothing, so this failure has to be told apart from the
 * store-level one — hence its own message.
 */
async function assertRuntimeHonoursAdditionalData() {
  const subtle = globalThis.crypto?.subtle;
  assert(subtle !== undefined, 'this runtime has no WebCrypto — client-side encryption cannot work here at all');

  const key = await subtle.importKey('raw', MASTER_KEY, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = new Uint8Array(12).fill(3);
  const plaintext = new TextEncoder().encode('bound to a key');
  const sealed = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('alice/state.json') },
    key,
    plaintext,
  );

  const wrongContext = await failureOf(() => subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('bob/state.json') },
    key,
    sealed,
  ));
  assert(
    wrongContext !== undefined,
    'this runtime decrypted an AES-GCM body under a different additionalData — its WebCrypto ignores the AAD, so the context binding authenticates nothing',
  );

  const noContext = await failureOf(() => subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed));
  assert(
    noContext !== undefined,
    'this runtime decrypted an AES-GCM body with the additionalData omitted entirely',
  );

  const roundTripped = await subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('alice/state.json') },
    key,
    sealed,
  );
  assert(
    new TextDecoder().decode(new Uint8Array(roundTripped)) === 'bound to a key',
    'an AES-GCM body did not round-trip under the additionalData it was sealed with',
  );
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
 * The store wraps a decode failure in a `JournalError` and keeps the
 * codec's own sentence one level down, so match against the flattened
 * chain rather than the top message.
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
