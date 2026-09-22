import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import {
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
} from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';

/**
 * The **strength** of the etag, as distinct from its behaviour (#786).
 *
 * The CAS tests in `FilesystemObjectStorageBackend.test.ts` are the reason
 * this file exists rather than a few more cases over there.  Every one of
 * them — "ifMatch with the correct etag succeeds; with a stale etag fails",
 * "equal bytes → equal etag across instances", the 10-way race — asks only
 * that the token be a *deterministic function of the body*.  A 32-bit FNV-1a
 * satisfies that, and so does any other format-preserving hash, so the whole
 * suite passes unchanged whichever one is in force.  It cannot tell a
 * four-byte token from a sixteen-byte one, which is precisely the property
 * #786 is about: this is the durable-state optimistic-concurrency token, so
 * an attacker who holds write access to the store can search for a body
 * colliding with the etag a CAS holder has already read, write it as the
 * *intervening* revision, and have the holder's stale `ifMatch` pass over
 * content that changed underneath them.
 *
 * So the assertions below are about the derivation itself, and they are
 * deliberately of three different kinds — each catches a wrong fix the other
 * two would wave through:
 *
 *   - **Width.**  Catches a narrower digest (the old four-byte token, or a
 *     SHA-256 truncated too far).  Says nothing about which primitive.
 *   - **A known-answer vector.**  `SHA-256("hello")` is a published constant,
 *     so a literal expectation pins the primitive, the truncation, the hex
 *     encoding and the string format at once, without the test re-deriving
 *     anything and without trusting its own re-derivation.  This is what
 *     catches a same-width wrong primitive — SHA-1 or SHA-512 truncated to
 *     sixteen bytes passes the width check and fails here.
 *   - **Independent recomputation over an arbitrary body.**  A known-answer
 *     vector alone could be satisfied by a lookup table; recomputing through
 *     WebCrypto covers bodies the vector does not name.
 *
 * And one binding assertion underneath all three: the value derived here has
 * to be the token `put` actually compares `ifMatch` against.  Without it this
 * file would be asserting about a string that merely *appears* in the return
 * value, and a change that strengthened the reported etag while leaving the
 * comparison on the old one would pass.
 *
 * **What is claimed, and what is not.**  This file's header used to say no
 * collision had been constructed and to settle for the hygiene property — a
 * security-relevant equality check should not rest on a four-byte
 * non-cryptographic hash.  Both halves were superseded by the #786
 * verification pass: a colliding 49-byte pair was built by birthday search
 * in seconds, and the lost update it enables is driven end to end by the
 * last `describe` in this file.  The old header also repeated the original
 * mechanism, which was backwards — see that `describe` for the correction
 * and for why the shipped hash was neither textbook FNV-1a nor invertible.
 *
 * The preconditions do still stack: this backend rather than S3, which
 * forwards `IfMatch` to the service and is unaffected; an attacker holding
 * write access to the store; a body matching the byte length as well, since
 * the length is a literal component of the string.  And the per-key `O_EXCL`
 * advisory lock still removes the ordinary race — it simply cannot make the
 * comparison itself sound.
 */

/** `"fs-<hex>-<byte length>"`, decomposed so each part can be asserted on. */
const ETAG_PATTERN = /^"fs-([0-9a-f]+)-(\d+)"$/;

/** 16 bytes of digest, hex-encoded — what `ETAG_DIGEST_BYTES` renders to. */
const ETAG_HEX_CHARACTERS = 32;

/**
 * `SHA-256("hello")`, truncated to 16 bytes.  A published test vector
 * (FIPS 180-4 / RFC 6234 exercise the same function), quoted here as a
 * literal on purpose: it is the one assertion in this file that depends on
 * nothing the repository computes, so it stays true even if both `src/` and
 * the helper below were wrong in the same direction.
 */
const SHA256_HELLO_TRUNCATED = '2cf24dba5fb0a30e26e83b2ac5b9e29e';

let tmpRoot: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-etag-'));
  const backendOptions = FilesystemObjectStorageOptions.create()
    .withDir(tmpRoot);
  backend = new FilesystemObjectStorageBackend(backendOptions);
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * The derivation restated independently of `src/` — straight through
 * WebCrypto, no import from the backend.  A test that called the backend's
 * own helper would assert only that the function equals itself.
 */
async function expectedEtag(body: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', body as unknown as BufferSource);
  const truncated = new Uint8Array(digest).subarray(0, ETAG_HEX_CHARACTERS / 2);
  const hex = Array.from(truncated, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `"fs-${hex}-${body.length}"`;
}

/**
 * The pre-#786 construction, kept verbatim.
 *
 * Naming the old token rather than describing it is what makes a revert fail
 * loudly instead of merely failing: the message then reads "got the FNV-1a
 * value", not "got some other string".  It is also the only assertion here
 * that would survive a future format change unchanged, which is why it is a
 * `not.toBe` on a value and not a regex over a shape.
 */
function legacyFnv1aEtag(body: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body[i]!;
    hash = (hash * 0x01000193) >>> 0;
  }
  hash ^= body.length;
  return `"fs-${(hash >>> 0).toString(16).padStart(8, '0')}-${body.length}"`;
}

/**
 * Run `body` with `globalThis.crypto.subtle` absent, restoring it afterwards.
 *
 * The stand-in forwards the two members that are not `subtle` rather than
 * spreading the real object: `getRandomValues` and `randomUUID` live on
 * `Crypto.prototype`, so `{ ...globalThis.crypto }` copies neither — and
 * `put` draws its temp-file suffix from `randomId` before it reaches the
 * digest, so a bare spread would fail the write for a missing CSPRNG and
 * never reach the guard the test is about.
 */
async function withoutSubtleCrypto<Result>(body: () => Promise<Result>): Promise<Result> {
  const realCrypto = globalThis.crypto;
  const withoutSubtle = {
    getRandomValues: <View extends ArrayBufferView | null>(array: View): View =>
      realCrypto.getRandomValues(array),
    randomUUID: () => realCrypto.randomUUID(),
    subtle: undefined,
  } as unknown as Crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: withoutSubtle, configurable: true, writable: true,
  });
  try {
    return await body();
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      value: realCrypto, configurable: true, writable: true,
    });
  }
}

/**
 * Run `body` with `globalThis.crypto.subtle.digest` counted, and report the
 * count alongside the result.
 *
 * The count is taken at WebCrypto rather than inside `computeEtag`, which is
 * module-private and would in any case report one derivation per call however
 * many times the caller makes it.  The question these cases ask is how often
 * `put` *reaches* the derivation, so the only honest place to count is the
 * primitive underneath it.
 *
 * The stand-in forwards `getRandomValues` and `randomUUID` for the reason
 * {@link withoutSubtleCrypto} gives, and exposes nothing on `subtle` but
 * `digest`: that is the whole of this backend's WebCrypto surface, so a
 * future call to anything else should fail here loudly rather than be
 * silently forwarded and uncounted.
 */
async function countingDigests<Result>(
  body: () => Promise<Result>,
): Promise<{ readonly result: Result; readonly digests: number }> {
  const realCrypto = globalThis.crypto;
  const realSubtle = realCrypto.subtle;
  let digests = 0;
  const counting = {
    getRandomValues: <View extends ArrayBufferView | null>(array: View): View =>
      realCrypto.getRandomValues(array),
    randomUUID: () => realCrypto.randomUUID(),
    subtle: {
      digest: (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
        digests += 1;
        return realSubtle.digest(algorithm, data);
      },
    },
  } as unknown as Crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: counting, configurable: true, writable: true,
  });
  try {
    return { result: await body(), digests };
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      value: realCrypto, configurable: true, writable: true,
    });
  }
}

describe('FilesystemObjectStorageBackend — CAS token strength (#786)', () => {
  test('the etag carries a 128-bit digest, not a 32-bit one', async () => {
    const { etag } = await backend.put('strength/width', bytes('hello'));
    const matched = ETAG_PATTERN.exec(etag);
    expect(matched).not.toBeNull();
    // The width is the whole point: the old token was 8 hex characters, so
    // this single expectation is what a revert trips over first.
    expect(matched![1]!).toHaveLength(ETAG_HEX_CHARACTERS);
    expect(matched![2]!).toBe('5');
  });

  test('the digest is SHA-256, pinned against a published vector', async () => {
    const { etag } = await backend.put('strength/vector', bytes('hello'));
    expect(etag).toBe(`"fs-${SHA256_HELLO_TRUNCATED}-5"`);
  });

  test('the derivation holds for an arbitrary body, and is not FNV-1a', async () => {
    // Long enough that a chance agreement between the two constructions is
    // not worth reasoning about, and not a round number.
    const body = bytes('durable-state revision 41 :: ' + 'x'.repeat(211));
    const { etag } = await backend.put('strength/arbitrary', body);
    expect(etag).toBe(await expectedEtag(body));
    expect(etag).not.toBe(legacyFnv1aEtag(body));
  });

  test('an empty body gets the same treatment — no short-circuit', async () => {
    // The old construction folded the length in so that empty and a single
    // zero byte would differ.  The digest does that on its own, and the empty
    // case is where a hand-rolled truncation is most likely to go wrong.
    const empty = new Uint8Array(0);
    const { etag } = await backend.put('strength/empty', empty);
    expect(etag).toBe(await expectedEtag(empty));
    expect(ETAG_PATTERN.exec(etag)![1]!).toHaveLength(ETAG_HEX_CHARACTERS);
  });

  test('get reports the same derivation put returned', async () => {
    const body = bytes('read path');
    await backend.put('strength/round-trip', body);
    const fetched = await backend.get('strength/round-trip');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) expect(fetched.value.etag).toBe(await expectedEtag(body));
  });

  test('the digest derived here IS the token put compares ifMatch against', async () => {
    // The binding assertion.  Everything above reads the etag out of a return
    // value; this drives it back in through the CAS path, so a change that
    // strengthened the *reported* etag while leaving the comparison on the old
    // derivation cannot pass.
    const first = bytes('v1');
    await backend.put('strength/cas', first);
    await backend.put('strength/cas', bytes('v2'), { ifMatch: await expectedEtag(first) });
    const fetched = await backend.get('strength/cas');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) expect(new TextDecoder().decode(fetched.value.body)).toBe('v2');
  });

  test('a stronger token is worth nothing if it can be silently downgraded', async () => {
    // The decision the JSDoc on `computeEtag` spends a paragraph on — no cheap
    // fallback — and the one this file's whole premise rests on.  A degrade
    // path taken on some runtime would reinstate the four-byte token there
    // while every assertion above still passed on this one, so it is precisely
    // the kind of change no other case in this suite can see.
    //
    // The guard is exercised the way `PeerDepValidation.test.ts` exercises the
    // encryption and integrity probes: `crypto.subtle` is wiped for the
    // duration of the call.  What the etag needs and those probes do not is a
    // surviving CSPRNG — `put` draws its temp-file suffix from `randomId`
    // before it ever reaches the digest — which is why the stand-in forwards
    // `getRandomValues` instead of being a bare spread.
    const error = await withoutSubtleCrypto(() =>
      backend.put('strength/no-fallback', bytes('hello')).then(() => null, (e: unknown) => e));
    expect(error).toBeInstanceOf(ObjectStorageBackendError);
    expect((error as Error).message).toMatch(/SubtleCrypto is not available/);
    // And it says *which* capability went missing.  The three WebCrypto
    // requirements in this directory — client-side encryption, body
    // integrity, and this etag — share the sentence above and differ only in
    // what follows it, so the shared opener is the half of the message that
    // identifies nothing.  Asserting only on it would let a refactor that
    // collapsed the three into one generic string pass while an operator lost
    // the only clue saying which subsystem to configure.
    expect((error as Error).message).toMatch(/compare-and-swap ETag from SHA-256/);
    // Refused, not degraded: nothing weaker came back in its place.
    expect((error as Error).message).not.toMatch(ETAG_PATTERN);
  });

  test('the read path refuses on the same terms', async () => {
    // `get` derives the etag a caller will later hand back as `ifMatch`, so a
    // fallback here would seed the CAS comparison with the weak token even
    // where `put` still used the strong one.
    await backend.put('strength/no-fallback-read', bytes('hello'));
    const error = await withoutSubtleCrypto(() =>
      backend.get('strength/no-fallback-read').then(() => null, (e: unknown) => e));
    expect(error).toBeInstanceOf(ObjectStorageBackendError);
    expect((error as Error).message).toMatch(/SubtleCrypto is not available/);
    expect((error as Error).message).toMatch(/compare-and-swap ETag from SHA-256/);
  });

  test('a WebCrypto fault on overwrite blames WebCrypto, not the disk read', async () => {
    // `put` re-reads the current object inside a `try` that relabels anything
    // non-ENOENT as `filesystem put-read-current failed for <key>`.  The digest
    // over those bytes sits *outside* that `try` on purpose: only `readFile` is
    // the read the branch is reporting on, and a `computeEtag` failure is a
    // WebCrypto fault that the relabelling would send an operator to check the
    // disk for.
    //
    // Overwriting an existing key is the one path where the two are adjacent —
    // a first write finds no bytes to digest, so it never reaches the call at
    // all — and it is what makes this test discriminating rather than a second
    // copy of the one above.
    //
    // The `ifMatch` is not decoration.  Since the read-current digest became
    // conditional, an overwrite that passes no CAS option no longer reaches
    // it at all: the only derivation left on that path is the one over the
    // body being written, and this case would quietly become a duplicate of
    // "a stronger token is worth nothing if it can be silently downgraded"
    // while staying green — measured, not assumed.  The value is irrelevant
    // (the digest throws before any comparison); what matters is that the
    // branch is entered.
    const first = bytes('v1');
    await backend.put('strength/relabel', first);
    const firstEtag = await expectedEtag(first);
    const error = await withoutSubtleCrypto(() =>
      backend.put('strength/relabel', bytes('v2'), { ifMatch: firstEtag })
        .then(() => null, (e: unknown) => e));
    expect((error as Error).message).toMatch(/SubtleCrypto is not available/);
    expect((error as Error).message).not.toMatch(/put-read-current/);
  });

  test('the old FNV-1a token is rejected as a CAS precondition', async () => {
    // The other half of the binding, and the one that fails closed: a writer
    // holding the pre-#786 token for the *current* bytes must not win the
    // comparison.  Asserting only the success case above would pass an
    // implementation that accepted either form.
    const body = bytes('v1');
    await backend.put('strength/legacy', body);
    await expect(
      backend.put('strength/legacy', bytes('v2'), { ifMatch: legacyFnv1aEtag(body) }),
    ).rejects.toBeInstanceOf(ObjectStorageConcurrencyError);
  });
});

/**
 * The lost update itself, driven through a constructed collision.
 *
 * Everything above argues from the *shape* of the token — its width, its
 * primitive, its format.  This is the defect: two different bodies that the
 * pre-#786 construction cannot tell apart, and the write they let through.
 *
 * The pair below was found by birthday search over random 49-byte bodies, in
 * seconds.  That is worth stating precisely, because the original account of
 * #786 got it wrong twice.  It said the old hash was "trivially invertible by
 * construction" — it was not: the shipped line was `hash = (hash *
 * 0x01000193) >>> 0`, a float64 multiply whose exact product exceeds 2^53 and
 * rounds, so it is not textbook FNV-1a and is not a bijection.  Measured
 * while building this fixture, it disagrees with a `Math.imul` FNV-1a on 2000
 * of 2000 random 49-byte bodies, and the rounding costs it space as well: 43
 * collisions in 400 000 random 49-byte bodies puts the effective size near
 * 2^30.8, so even odds arrive around 50 000 bodies rather than the ~65 000 a
 * full 32-bit space would need.  A search, then — not an inversion, and
 * cheaper than the number that was quoted.
 *
 * And the attack runs the other way round from the one first described.  A
 * stale writer computing a body that matches an etag *they* hold gains
 * nothing, because `put` compares `ifMatch` against the etag of the bytes on
 * disk — their own new body never enters the comparison.  The mechanism is
 * the **intervening writer**: they author the body that lands in between so
 * that its etag equals what the CAS holder already read.  The holder's stale
 * precondition then passes over content that changed underneath them, and
 * their write clobbers it.  For `ObjectStorageDurableStateStore` that is the
 * revision check failing open.
 */

/**
 * Two distinct 49-byte bodies with one pre-#786 etag: `"fs-69574da1-49"`.
 *
 * Kept as literals rather than re-derived by a search in the test.  A search
 * makes the case depend on a random draw and on the old construction still
 * being implemented correctly in {@link legacyFnv1aEtag}; a pair pins the
 * finding itself, and the first assertion below checks the collision is real
 * rather than assuming it.
 */
const COLLIDING_BODY_A = 'A-hou_kSMxl_S3n6WFvGsrvW29uaJOmvQJNuK3ls3DWkcT5WJ';
const COLLIDING_BODY_B = '58crsNx-sPA4eaSXCo1H0RWlFdWBqwTflpHAQBJZXBuEsteGD';

describe('FilesystemObjectStorageBackend — the constructed collision (#786)', () => {
  test('the pair really does collide under the pre-#786 construction', async () => {
    // The premise of the two cases below, asserted rather than asserted-to.
    // Same length as well as same hash: the length is a literal component of
    // the etag string, so a pair differing in it would collide in neither
    // construction and prove nothing.
    expect(COLLIDING_BODY_A).not.toBe(COLLIDING_BODY_B);
    expect(COLLIDING_BODY_A.length).toBe(COLLIDING_BODY_B.length);
    expect(legacyFnv1aEtag(bytes(COLLIDING_BODY_A)))
      .toBe(legacyFnv1aEtag(bytes(COLLIDING_BODY_B)));
  });

  test('the shipped etag separates them', async () => {
    const { etag: etagA } = await backend.put('collision/a', bytes(COLLIDING_BODY_A));
    const { etag: etagB } = await backend.put('collision/b', bytes(COLLIDING_BODY_B));
    expect(etagA).not.toBe(etagB);
  });

  test('an intervening writer cannot make a stale ifMatch pass', async () => {
    // The lost update, end to end.
    //
    //   1. The holder reads the object and keeps its etag.
    //   2. An attacker overwrites it with the colliding body — a legitimate
    //      write, and one the per-key lock has nothing to say about.
    //   3. The holder writes back under its now-stale precondition.
    //
    // Step 3 must be refused.  Under the pre-#786 token it succeeded, because
    // the etag of the attacker's body on disk equalled the one the holder was
    // holding, and the holder's write then destroyed content it had never
    // seen.
    await backend.put('collision/cas', bytes(COLLIDING_BODY_A));
    const held = await backend.get('collision/cas');
    expect(held.isSome()).toBe(true);
    const heldEtag = held.isSome() ? held.value.etag : '';

    await backend.put('collision/cas', bytes(COLLIDING_BODY_B));

    await expect(
      backend.put('collision/cas', bytes('the holder\'s own next revision'), { ifMatch: heldEtag }),
    ).rejects.toBeInstanceOf(ObjectStorageConcurrencyError);

    // Refused *and* nothing written: the attacker's body is still there, so
    // the holder will re-read and notice rather than silently win.
    const after = await backend.get('collision/cas');
    expect(after.isSome()).toBe(true);
    if (after.isSome()) {
      expect(new TextDecoder().decode(after.value.body)).toBe(COLLIDING_BODY_B);
    }
  });
});

/**
 * **Where the digest is derived, as distinct from what it is.**
 *
 * The cases above all read a token out of a return value or drive one back
 * through `ifMatch`; none of them can see a derivation whose value is
 * discarded.  That is exactly what `put` used to do on every overwrite: it
 * digested the object already on disk unconditionally, although only the
 * `ifMatch` branch reads that value — `ifNoneMatch: '*'` needs to know that
 * bytes exist, not what they hash to, and a put with no CAS option at all
 * needs neither.
 *
 * While the etag was a 32-bit loop over the body that was the right shape:
 * the derivation was free and unconditional code is simpler.  With SHA-256
 * behind WebCrypto it is a real call on the hot path of every durable-state
 * upsert and every snapshot save, neither of which passes a CAS option
 * (`ObjectStorageSnapshotStore.save` puts bare).
 *
 * So these cases count the calls rather than inspect the values, because the
 * saving is invisible to any assertion about the etag itself — and counting
 * both directions matters: a guard that skipped the derivation where
 * `ifMatch` *does* need it would leave every case above green while breaking
 * the comparison, which is why the last case here is a floor and not a
 * ceiling.
 */
describe('FilesystemObjectStorageBackend — when the etag digest is derived', () => {
  test('a first write derives exactly the one etag it returns', async () => {
    const { result, digests } = await countingDigests(() =>
      backend.put('digest/first', bytes('v1')));
    expect(result.etag).toBe(await expectedEtag(bytes('v1')));
    expect(digests).toBe(1);
  });

  test('an overwrite with no CAS option derives one digest, not two', async () => {
    await backend.put('digest/plain', bytes('v1'));
    const { digests } = await countingDigests(() =>
      backend.put('digest/plain', bytes('v2')));
    // The body being written, and nothing for the bytes being replaced.
    expect(digests).toBe(1);
  });

  test("an ifNoneMatch:'*' conflict derives no digest at all", async () => {
    await backend.put('digest/create-conflict', bytes('v1'));
    const { digests } = await countingDigests(() =>
      backend.put('digest/create-conflict', bytes('v2'), { ifNoneMatch: '*' })
        .then(() => null, () => null));
    // The branch asks whether bytes are there, which `readFile` already
    // answered; it never reads the token's value.
    expect(digests).toBe(0);
  });

  test('an ifMatch overwrite still derives the current object it compares against', async () => {
    const first = bytes('v1');
    await backend.put('digest/cas', first);
    // Derived before the counter is installed, so the expectation counts
    // only what `put` itself does.
    const firstEtag = await expectedEtag(first);
    const { digests } = await countingDigests(() =>
      backend.put('digest/cas', bytes('v2'), { ifMatch: firstEtag }));
    // One for the bytes on disk — the comparison's left-hand side — and one
    // for the body being written.  Dropping either is a different defect
    // from the one the cases above are about.
    expect(digests).toBe(2);
  });
});
