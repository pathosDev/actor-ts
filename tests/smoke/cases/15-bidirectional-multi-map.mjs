/**
 * Smoke case: BidirectionalMultiMap survives a serializer round-trip (#1037).
 *
 * Same reasoning as case 14, and the same risk: `JsonTree` decides to emit
 * `__bidirectionalmultimap__` by asking `value instanceof
 * BidirectionalMultiMap`, a cross-module identity check.  If the built
 * package ever resolved to two copies of the module on some runtime (a
 * dual-package hazard, a bundler splitting it, Deno resolving the specifier
 * differently), that check would quietly answer false.
 *
 * The consequence is worse here than it is for the 1:1 map.  That one would
 * fall through to `encodeObject` and at least come back as a plain
 * `{ forward, reverse }` with the data intact.  This one holds both
 * directions as `Map<_, Set<_>>` behind private fields the walker never
 * reaches, so a missed `instanceof` stores `{ forward: {}, reverse: {},
 * counter: { pairs: 3 } }` — a pair count and no pairs.  Nothing throws;
 * state simply comes back empty, on whichever runtime the user picked.
 *
 * A unit test on Bun cannot see that, because it imports the source directly
 * and there is only ever one copy.  This runs against the built entry point
 * on all three runtimes, which is the only place the identity is at risk.
 *
 * Since #1036 there is a SECOND such check, in `CborCodec`, with exactly the
 * same exposure — so both serializers are exercised here rather than one.
 */
export const name = 'BidirectionalMultiMap round-trip';
export const description = 'the BidirectionalMultiMap tag survives a built-package serializer round-trip';

export async function run({ actorTs, loadEntry }) {
  const { BidirectionalMultiMap } = actorTs;
  const { JsonSerializer, CborSerializer } = await loadEntry('serialization');

  const source = new BidirectionalMultiMap([['news', 'ada'], ['news', 'grace'], ['sport', 'ada']]);

  for (const [label, serializer] of [['json', new JsonSerializer()], ['cbor', new CborSerializer()]]) {
    const restored = serializer.fromBinary(serializer.toBinary(source), serializer.manifest(source));

    if (!(restored instanceof BidirectionalMultiMap)) {
      throw new Error(
        `${label}: round-trip lost the class: got ${restored?.constructor?.name ?? typeof restored} — `
        + 'the instanceof check in the codec did not match, so the tag was never emitted',
      );
    }
    if (restored.size !== 3) throw new Error(`${label}: size ${restored.size} !== 3`);
    if (!restored.has('news', 'ada')) throw new Error(`${label}: forward direction lost`);
    // Never written to the wire — if this answers, it was genuinely rebuilt.
    const holders = [...restored.getKeys('ada')].join(',');
    if (holders !== 'news,sport') throw new Error(`${label}: inverse not rebuilt: ${holders}`);

    // Participant counts (#1199).  These are prototype getters, so a decode that
    // handed back a plain object rather than an instance reads `undefined` here
    // — the same cross-module identity failure this case exists for, caught one
    // step further in: `rightSize` in particular reads the reverse map, which is
    // never written to the wire at all.
    if (restored.leftSize !== 2 || restored.rightSize !== 2) {
      throw new Error(
        `${label}: participant counts came back as `
        + `leftSize=${restored.leftSize} rightSize=${restored.rightSize}, expected 2 and 2`,
      );
    }

    if (Object.prototype.toString.call(restored) !== '[object BidirectionalMultiMap]') {
      throw new Error(`${label}: toStringTag: ${Object.prototype.toString.call(restored)}`);
    }

    // Participant pruning is the invariant the class exists for; it must hold
    // on the built bundle too, including after a round-trip.
    restored.deleteRight('ada');
    if (restored.hasLeft('sport')) {
      throw new Error(`${label}: sport held only ada and should have been pruned with it`);
    }
    if (restored.size !== 1 || [...restored.rights()].join(',') !== 'grace') {
      throw new Error(`${label}: pruning left the relation inconsistent: size=${restored.size}`);
    }
    // …and the counts followed the pruning rather than going stale with it.
    if (restored.leftSize !== 1 || restored.rightSize !== 1) {
      throw new Error(
        `${label}: pruning left the counts stale: `
        + `leftSize=${restored.leftSize} rightSize=${restored.rightSize}, expected 1 and 1`,
      );
    }
  }
}
