/**
 * Direct-message helpers shared between backend and frontends.
 *
 * **Design (added in #100)**: a DM is modelled as a *sharded entity
 * per ordered pair of participants*.  Two users `alice` and `bob`
 * share exactly one channel — `alice|bob` — regardless of who DMed
 * whom first.  The canonical form is the lexicographic-sorted
 * `min|max` join, which:
 *
 *   1. **Gives a stable shard key** for `ClusterSharding` — so both
 *      participants' messages always land on the same `DirectMessageChannelActor`
 *      instance regardless of which node they're connected to.
 *   2. **Avoids journal duplication**: `persistenceId =
 *      "dm-channel-<pair-id>"`, one journal stream per conversation
 *      rather than two ("alice→bob" + "bob→alice").
 *   3. **Lets either side find the channel** without coordination:
 *      `canonicalPairId(self, other)` gives the same answer
 *      regardless of who's asking.
 *
 * **Why `|` as separator?**  It's already prohibited by `isRoomName`
 * (which enforces `[A-Za-z0-9_-]`), so it can never appear inside a
 * username — splitting back to participants is unambiguous.  The
 * separator is otherwise arbitrary; `:` would work too but `|` reads
 * as visually distinct in logs.
 *
 * **What about group DMs (3+ participants)?**  Out of scope for this
 * sample — the issue body explicitly says "private rooms cover that
 * case" (a private invite-only room is structurally a group DM).
 * The pair-id encoding is order-invariant but cardinality-bound: it
 * would need a different shape for N>2.
 */

/**
 * Build the canonical pair-id for two participants.  Order-invariant:
 * `canonicalPairId('alice', 'bob') === canonicalPairId('bob', 'alice')`.
 *
 * @throws if either argument contains `|` (shouldn't happen — usernames
 *   are constrained by `isRoomName` to `[A-Za-z0-9_-]`).
 */
export function canonicalPairId(a: string, b: string): string {
  if (a.includes('|') || b.includes('|')) {
    throw new Error(`invalid username for DM pair-id: '|' not allowed`);
  }
  // Lexicographic sort — the comparison is the cheapest stable
  // canonicalization that gives identical strings for both orderings.
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Split a canonical pair-id back into its two participants. */
export function splitPairId(pairId: string): readonly [string, string] | null {
  const idx = pairId.indexOf('|');
  if (idx <= 0 || idx === pairId.length - 1) return null;
  return [pairId.slice(0, idx), pairId.slice(idx + 1)];
}

/** Topic each user subscribes to for incoming DMs. */
export function directMessageInboxTopic(username: string): string {
  return `chat.dm.user.${username}`;
}
