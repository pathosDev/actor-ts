/**
 * Smoke case: BidirectionalMap survives a serializer round-trip (#1035).
 *
 * The class itself is plain `Map` underneath and holds no runtime-specific
 * API, so it is not what this case is really about.  The tag is.
 *
 * `JsonTree` decides to emit `__bidirectionalmap__` by asking `value
 * instanceof BidirectionalMap` — a cross-module identity check.  If the
 * built package ever resolved to two copies of the module on some runtime
 * (a dual-package hazard, a bundler splitting it, Deno resolving the
 * specifier differently), that check would quietly answer false and the map
 * would encode as a plain object instead.  Nothing would throw: state would
 * simply come back without its class, on whichever runtime the user picked.
 *
 * A unit test on Bun cannot see that, because it imports the source
 * directly and there is only ever one copy.  This runs against the built
 * entry point on all three runtimes, which is the only place the identity
 * is actually at risk.
 */
export const name = 'BidirectionalMap round-trip';
export const description = 'the __bidirectionalmap__ tag survives a built-package serializer round-trip';

export async function run({ actorTs }) {
  const { BidirectionalMap, JsonSerializer } = actorTs;

  const source = new BidirectionalMap([['ada', 1], ['grace', 2]]);
  const serializer = new JsonSerializer();
  const restored = serializer.fromBinary(serializer.toBinary(source), serializer.manifest(source));

  if (!(restored instanceof BidirectionalMap)) {
    throw new Error(
      `round-trip lost the class: got ${restored?.constructor?.name ?? typeof restored} — `
      + 'the instanceof check in JsonTree did not match, so the tag was never emitted',
    );
  }
  if (restored.get('ada') !== 1) throw new Error(`forward direction lost: ${restored.get('ada')}`);
  // Never written to the wire — if this answers, it was genuinely rebuilt.
  if (restored.getKey(2) !== 'grace') throw new Error(`inverse not rebuilt: ${restored.getKey(2)}`);
  if (restored.size !== 2) throw new Error(`size ${restored.size} !== 2`);

  // The Map contract it claims, on the built bundle.
  if (new Map(restored).get('grace') !== 2) throw new Error('not consumable as a Map');
  if (Object.prototype.toString.call(restored) !== '[object BidirectionalMap]') {
    throw new Error(`toStringTag: ${Object.prototype.toString.call(restored)}`);
  }

  // Displacement is the one Map-contract departure; it must hold everywhere.
  const displaced = new BidirectionalMap([['a', 1]]);
  displaced.set('b', 1);
  if (displaced.size !== 1 || displaced.has('a')) {
    throw new Error(`set did not displace: size=${displaced.size} has('a')=${displaced.has('a')}`);
  }
}
