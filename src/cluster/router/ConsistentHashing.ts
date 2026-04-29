/**
 * Consistent-hashing primitive for `ClusterRouter` — pinning a key to
 * one routee out of an N-routee set, with the property that adding or
 * removing a routee re-routes only **1/N** of keys instead of (1 − 1/N).
 *
 * We use **rendezvous hashing** (a.k.a. highest-random-weight): for
 * each candidate, hash `(key, candidateId)` together and pick the
 * candidate with the highest hash.  The "candidateId" is whatever
 * stable string identifies the routee — typically its node address.
 *
 *   pickRendezvous('order-42', addrs)   // → addrs[k]
 *   pickRendezvous('order-42', addrs)   // → same addrs[k] — stable
 *   pickRendezvous('order-42', addrs.slice(0, -1))
 *     // → still addrs[k] unless k was the dropped one
 *
 * The hash is FNV-1a-derived (same family used by `ShardAllocator`),
 * so behaviour is consistent across the codebase and across nodes.
 */

/**
 * Pick the candidate with the highest combined-hash for `key`.
 * `candidates` is iterated in order; ties are broken by first-occurrence
 * to keep behaviour deterministic given identical inputs.
 *
 * Throws if `candidates` is empty — callers should check beforehand.
 */
export function pickRendezvous<T>(
  key: string,
  candidates: ReadonlyArray<T>,
  identityOf: (c: T) => string,
): T {
  if (candidates.length === 0) {
    throw new Error('pickRendezvous: candidates list is empty');
  }
  let bestHash = -1;
  let best: T = candidates[0]!;
  for (const c of candidates) {
    const h = hashCombine(key, identityOf(c));
    if (h > bestHash) { bestHash = h; best = c; }
  }
  return best;
}

/* ------------------------------ helpers --------------------------------- */

/**
 * FNV-1a 32-bit string hash — same algorithm `ShardAllocator` uses for
 * shard-id hashing.  Stable across runtimes; not cryptographically
 * strong but plenty for routing.
 */
function fnv1a(s: string): number {
  let h = 2166136261; // FNV-1a 32-bit basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

/**
 * Mix two strings into a single 32-bit unsigned integer.  Deliberately
 * symmetric in the sense that callers can think of the inputs as a
 * pair (key, candidateId) — but order **does** matter (the second
 * argument is mixed into the hash of the first), which is what we
 * want: `hashCombine('a', 'b') !== hashCombine('b', 'a')` keeps the
 * (key, candidate) pairing meaningful.
 */
function hashCombine(a: string, b: string): number {
  let h = fnv1a(a) ^ Math.imul(fnv1a(b), 2654435761);
  h ^= h >>> 13;
  h = Math.imul(h, 1540483477);
  return h >>> 0;
}
