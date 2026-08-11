/**
 * The framework's own draws go through the `exists` predicate (#1146).
 *
 * #1141 added the predicate; this file covers the three call sites that have a
 * registry worth checking.  All three are guarded by entropy that makes a
 * repeat astronomically unlikely, which is exactly why the wiring cannot be
 * observed by drawing a lot and hoping — every test here **replaces the
 * entropy with a constant**, so the second draw is guaranteed to repeat the
 * first, and then asserts the specific failure that repeat used to cause.
 *
 * With a constant source the redraw can never succeed, so the observable
 * outcome is the bounded retry giving up and throwing.  That is the point: the
 * pre-#1146 code returned the colliding value *silently*, and each test below
 * names the damage that silence did.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Actor } from '../../../src/Actor.js';
import { NoopLogger } from '../../../src/Logger.js';
import { ORSet } from '../../../src/crdt/ORSet.js';
import { _nextAskIdForTest } from '../../../src/cluster/ClusterClient.js';

const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const realRandomUuid = globalThis.crypto.randomUUID.bind(globalThis.crypto);

/**
 * Make `getRandomValues` deterministic, so `randomId` returns the same string
 * every call.  Byte 0 maps to the first character of whatever alphabet is in
 * play, and is below every rejection ceiling, so nothing is discarded and the
 * draw terminates.
 */
function freezeRandomBytes(): void {
  globalThis.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
    return array;
  }) as typeof globalThis.crypto.getRandomValues;
}

function freezeRandomUuid(value: string): void {
  globalThis.crypto.randomUUID = (() => value) as typeof globalThis.crypto.randomUUID;
}

afterEach(() => {
  globalThis.crypto.getRandomValues = realGetRandomValues;
  globalThis.crypto.randomUUID = realRandomUuid;
});

describe('ORSet.add draws its tag against live tags and tombstones', () => {
  test('a repeat of a tombstoned tag is refused instead of silently vanishing', () => {
    // The severe case.  A tag equal to one already tombstoned for this element
    // is vetoed on the next merge by the rule that stops a slow peer
    // resurrecting a removed tag — the veto cannot tell the two apart.  Before
    // #1146 `add` returned a set that said `has('apple') === true` and then
    // dropped the element on the first merge, with no error anywhere.
    // Freeze first, so the tag the seeding add mints is the exact one the
    // retrying add will keep redrawing.
    freezeRandomBytes();
    const seeded = ORSet.empty<string>().add('replica-a', 'apple');
    const tombstoned = seeded.remove('apple');
    expect(tombstoned.has('apple')).toBe(false);

    // Same replica, same element, same frozen entropy → the only candidate the
    // draw can produce is the tombstoned tag, so the bounded retry gives up
    // rather than handing back a tag the next merge would veto.
    expect(() => tombstoned.add('replica-a', 'apple')).toThrow(/randomId drew 1000 candidates/);
  });

  test('a repeat of a live tag is refused too', () => {
    freezeRandomBytes();
    const once = ORSet.empty<string>().add('replica-a', 'apple');
    // Less damaging than the tombstone case — a duplicate tag unions into the
    // same set — but it means the second add contributed nothing while looking
    // like it had, so the element dies on the first `remove` that only the
    // first add justified.
    expect(() => once.add('replica-a', 'apple')).toThrow(/randomId drew 1000 candidates/);
  });

  test('a different replica is a different tag space, so no redraw is needed', () => {
    // The prefix is part of the tag, so two replicas drawing the same suffix do
    // not collide.  This is what keeps the check from firing across replicas.
    freezeRandomBytes();
    const set = ORSet.empty<string>().add('replica-a', 'apple').add('replica-b', 'apple');
    expect(set.has('apple')).toBe(true);
  });
});

describe('ClusterClient.nextAskId draws against the pending map', () => {
  test('an id already pending is not handed out again', () => {
    // `pending.set(askId, …)` overwrites, so before #1146 a repeat replaced the
    // earlier ask's resolve/reject — that promise then hung until its own timer
    // fired, reporting a timeout that never happened.
    const frozen = '11111111-1111-4111-8111-111111111111';
    freezeRandomUuid(frozen);
    const pending = new Map<string, unknown>([[frozen, { resolve: () => {}, reject: () => {} }]]);

    expect(() => _nextAskIdForTest(pending)).toThrow(/randomUuid drew 1000 candidates/);
  });

  test('the polarity is right — a free id is returned, not rejected', () => {
    // The inverted-predicate failure this test exists to catch would make every
    // draw look taken and turn every ask into a throw.
    const frozen = '22222222-2222-4222-8222-222222222222';
    freezeRandomUuid(frozen);
    expect(_nextAskIdForTest(new Map())).toBe(frozen);
  });

  test('the bare handle still draws, for the #120 regression tests', () => {
    expect(_nextAskIdForTest()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

class Idle extends Actor<unknown> {
  override onReceive(): void {}
}

describe('ActorCell names anonymous children against the child map', () => {
  test('generated names stay unique across many spawns under one parent', async () => {
    // Honest about what this does and does not prove.  The counter in
    // `$anonymous-<n>-<random>` already disambiguates, so a frozen entropy
    // source does *not* force a collision here the way it does for the two
    // sites above — the names differ in the counter regardless.  There is no
    // way to force one from outside either: the `$anonymous-` prefix is
    // reserved, so a caller cannot plant a colliding name with `spawn`.
    //
    // What is left to assert is the invariant `_createChild` throws over, which
    // is the reason the check was added: distinct names under one parent.
    const system = ActorSystem.create('anon-names', ActorSystemOptions.create().withLogger(new NoopLogger()));
    try {
      const names = new Set<string>();
      for (let i = 0; i < 500; i++) {
        names.add(system.spawnAnonymous(Idle).path.name);
      }
      expect(names.size).toBe(500);
      for (const name of names) expect(name).toMatch(/^\$anonymous-\d+-[0-9a-f]{12}$/);
    } finally {
      await system.terminate();
    }
  });
});
