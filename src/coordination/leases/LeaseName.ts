/**
 * Deterministic truncation for backend object names.
 *
 * A `coordination.k8s.io/v1` Lease name is validated by the API server as a
 * DNS-1123 subdomain, so a lease named after something the application owns —
 * a sharded entity id, a tenant key, a composed singleton path — can exceed
 * what the server will accept. Until now such a name was simply sent, and came
 * back as an opaque `K8sLeaseError` from the first GET, at the point where the
 * singleton was trying to start.
 *
 * The truncation has to be a *function of the name alone*: two pods deriving
 * different object names from the same lease name would each acquire their own
 * record and both believe they hold it, which is the exact failure a lease
 * exists to prevent. Nothing here may consult a clock, a counter or the
 * process identity.
 */

/** Base-36 digits appended after the separator when a name is truncated. */
const HASH_LENGTH = 7;

/**
 * The separator plus the hash — the tail every truncated name carries, and the
 * budget {@link truncateLeaseName} subtracts from `maxLength` before slicing.
 */
const SUFFIX_LENGTH = HASH_LENGTH + 1;

/**
 * The shortest `maxLength` that can still produce a valid DNS-1123 subdomain:
 * the hash tail plus at least one leading character, because a name may not
 * begin with the `-` the tail starts with.
 */
export const MINIMUM_LEASE_NAME_MAX_LENGTH = SUFFIX_LENGTH + 1;

/**
 * FNV-1a over the **whole** original name, as an unsigned 32-bit integer.
 *
 * The body is the same one `ShardAllocator` uses for shard placement (it is
 * private there); it is repeated rather than shared because the two answer
 * different questions and neither should become a compatibility constraint on
 * the other — changing shard placement is a rebalance, changing this is a
 * rename of live Lease objects.
 *
 * 32 bits is enough for what this is: a tie-break between application names
 * that happen to share a long prefix, inside one namespace. It is not a
 * security boundary, and a collision means two leases contend for one record —
 * i.e. over-exclusion, never the mutual exclusion silently coming off.
 */
function fnv1a32(text: string): number {
  let hash = 2166136261; // FNV-1a 32-bit basis
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Fit `name` into `maxLength` characters, unchanged where it already fits.
 *
 * A name that is too long keeps as much of its head as the budget allows and
 * gains `-<hash>`, where the hash is a zero-padded base-36 FNV-1a of the full
 * original — so the head stays readable in `kubectl get leases` while two
 * names sharing a prefix still land on different objects.
 *
 * The head has trailing `-` and `.` stripped, since a DNS-1123 subdomain may
 * not end a label on either and the slice can land anywhere. Stripping can
 * empty the head (a name that is all separators past the cut); the leading `-`
 * of the tail is then dropped too, because base-36 digits are legal at the
 * start of a name and a leading `-` is not.
 */
export function truncateLeaseName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const hash = fnv1a32(name).toString(36).padStart(HASH_LENGTH, '0');
  const head = name.slice(0, Math.max(0, maxLength - SUFFIX_LENGTH)).replace(/[-.]+$/, '');
  return head.length > 0 ? `${head}-${hash}` : hash;
}
