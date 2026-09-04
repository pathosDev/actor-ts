import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageConcurrencyError } from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';

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
 * an attacker who drives the plaintext and holds write access can *compute* a
 * colliding body rather than search for one, and win a CAS check they should
 * lose.
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
 * **What is deliberately not claimed here.**  No collision was constructed
 * against the old token, and the preconditions for the original finding stack
 * up (this backend rather than S3, which forwards `IfMatch` to the service and
 * is unaffected; an attacker who both drives the plaintext and holds write
 * access; a forged body matching the byte length as well, since the length is
 * a literal component of the string).  The per-key `O_EXCL` advisory lock
 * already removes the ordinary race — it simply cannot make the comparison
 * itself sound.  This suite is the hygiene property written down as a gate: a
 * security-relevant equality check does not rest on a four-byte
 * non-cryptographic hash.
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
