import { none, some, type Option } from '../util/Option.js';
import { randomId } from '../util/RandomString.js';
import { CacheError, type Cache } from './Cache.js';

/**
 * A held mutual-exclusion lock, handed out by {@link acquireLock}.
 *
 * Exists so that "release" can mean *release what I took* rather than
 * *delete this key*.  The two differ the moment a holder overruns its
 * TTL: the entry it wrote is gone, someone else has written their own,
 * and a bare `cache.delete(key)` at that point silently evicts the new
 * owner's lock while they are still inside the critical section.  The
 * token pins the identity that makes the difference checkable.
 */
export interface CacheLock {
  /** The cache key this lock occupies. */
  readonly key: string;
  /**
   * The random value written under {@link key} — the proof of ownership
   * that {@link release} checks.  Exposed because a caller that also
   * writes a fencing token into the resource it is guarding needs the
   * same value on both sides.
   */
  readonly token: string;
  /**
   * Release the lock, but only while it is still ours.
   *
   * Returns `true` when our token was still in place and the delete was
   * issued; `false` when the lock had already lapsed — its TTL expired
   * and either nobody or somebody else now holds the key.  A `false`
   * return is worth acting on: it says the critical section ran longer
   * than its TTL, so another holder may have been running concurrently
   * and whatever this one just did was not, in fact, exclusive.
   *
   * Idempotent — a second call finds no matching token and returns
   * `false`.  Best-effort in the same sense as `Cache.delete`, which
   * swallows transient backend errors; `true` means "still ours, delete
   * issued", not "delete confirmed durable".
   */
  release(): Promise<boolean>;
}

/**
 * 128 bits, hex.  A lock token is a capability — anything holding it can
 * release the lock — so it is sized to be unguessable rather than merely
 * unlikely to collide, which the far shorter framework-internal ids
 * (~48 bits) are only ever asked to be.
 */
const TOKEN_LENGTH = 32;

/**
 * Take a mutually-exclusive lock on `key`, held for at most `ttlMs`.
 *
 * A thin, honest wrapper over {@link Cache.setIfAbsent} — that method is
 * already atomic on every backend, so this adds no exclusion the cache
 * did not have.  What it adds is the *release* half, which callers
 * otherwise write themselves and usually write wrong: a random token is
 * stored as the value, and release deletes the key only if that token is
 * still the one there.
 *
 * ```ts
 * const lock = await acquireLock(cache, 'lock:nightly-report', 30_000);
 * if (lock.isNone()) return;              // someone else is on it
 * try {
 *   await generateReport();
 * } finally {
 *   await lock.value.release();
 * }
 * ```
 *
 * **`ttlMs` is required, deliberately.**  The lock's only recovery path
 * from a holder that crashed, stalled past its deadline, or lost the
 * network is expiry; an infinite lock is a lock that wedges forever the
 * first time a process dies at the wrong moment.  Size it above the
 * realistic worst-case duration of the critical section — too short and
 * the TTL lapses mid-work, which is precisely the case `release`
 * reports as `false`.
 *
 * **What this is not.**  The compare-and-delete in `release` is a `get`
 * followed by a `delete`, not one atomic step — the `Cache` surface has
 * no compare-and-delete primitive, and adding one (a Redis Lua script)
 * would not be implementable on Memcached at all.  The residual window
 * is narrow and strictly better than the alternative: an unconditional
 * delete is wrong for the entire span after the TTL lapses, whereas this
 * is wrong only if the lock lapses *and* is re-acquired in the gap
 * between our own `get` and `delete`.  It is not a distributed-consensus
 * lock either: correctness still rests on the backend being a single
 * logical keyspace, and on clocks not drifting far enough to make a TTL
 * mean different things to different holders.  For anything where two
 * concurrent holders would be a correctness bug rather than wasted work,
 * guard the resource with a fencing token and not with this.
 *
 * @returns `Some(lock)` when the lock was taken, `None` when someone
 *          else holds it.  Throws `CacheError` on a non-positive or
 *          non-finite `ttlMs`, matching every other TTL-taking method.
 */
export async function acquireLock(cache: Cache, key: string, ttlMs: number): Promise<Option<CacheLock>> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CacheError(`acquireLock: ttlMs must be a positive finite number, got ${ttlMs}`);
  }
  const token = randomId(TOKEN_LENGTH);
  const acquired = await cache.setIfAbsent(key, token, ttlMs);
  if (!acquired) return none;
  return some({
    key,
    token,
    release: (): Promise<boolean> => releaseIfStillHeld(cache, key, token),
  });
}

async function releaseIfStillHeld(cache: Cache, key: string, token: string): Promise<boolean> {
  const held = await cache.get<string>(key);
  if (held.toNullable() !== token) return false;
  await cache.delete(key);
  return true;
}
