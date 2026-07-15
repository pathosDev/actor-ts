/**
 * Constant-time scrypt-based password verification — the
 * production-realistic upgrade landed in #99.
 *
 * **Why scrypt and not bcrypt?**  Node ships `crypto.scrypt`
 * built-in — zero dependencies, ~10–100 ms per hash on commodity
 * hardware with the parameters we use.  Memory-hard like bcrypt /
 * argon2 (it requires `~128 * N * r` bytes of memory while computing,
 * so ASIC/GPU attacks gain less than from MD5/SHA512).  bcrypt and
 * argon2 would need a third-party package; scrypt buys the same
 * security story without that.
 *
 * **Parameters** match the values used to pre-compute the hashes
 * baked into `shared/users.ts`:
 *
 *   - `N = 16384` (2^14) — CPU/memory cost.  Doubled = 2× cost.
 *   - `r = 8`           — block size, standard.
 *   - `p = 1`           — parallelism, standard.
 *   - `keyLen = 32`     — 256-bit output.
 *   - `maxmem = 64 MiB` — required because Node's default 32 MiB cap
 *     is sometimes not enough at N=16384.
 *
 * These give ~10 ms per verify on a modern laptop — slow enough that
 * a stolen hash list costs significant compute to brute-force, fast
 * enough that the login path doesn't feel laggy.  Production-tier
 * services typically bump `N` higher (32k or 65k) as hardware
 * improves.
 *
 * **Compare** uses `crypto.timingSafeEqual` so a hash-mismatch leaks
 * no timing info about *where* the mismatch occurred.
 */
import * as crypto from 'node:crypto';

const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const KEY_LEN = 32;

/**
 * Verify `plain` against a stored `<salt-hex>:<hash-hex>` record.
 * Returns `false` for malformed records and for mismatches alike —
 * no distinguishing error message exposed.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep <= 0 || sep === stored.length - 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(stored.slice(0, sep), 'hex');
    expected = Buffer.from(stored.slice(sep + 1), 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;
  let computed: Buffer;
  try {
    computed = crypto.scryptSync(plain, salt, KEY_LEN, SCRYPT_PARAMS);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(computed, expected);
}

/**
 * Hash `plain` with a fresh random salt.  Returned in the same
 * `<salt-hex>:<hash-hex>` format `verifyPassword` consumes.  Used
 * by anyone wanting to add new test users — call this offline and
 * paste the result into `shared/users.ts`.
 *
 * Not used at server start-up: the demo's hashes are pre-baked into
 * source for repeatability.
 */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, KEY_LEN, SCRYPT_PARAMS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
