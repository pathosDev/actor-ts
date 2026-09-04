import { describe, expect, test } from 'bun:test';

import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  MAX_CONFIGURATION_FACTS,
  MAX_CONFIGURATION_FACT_NAME_LENGTH,
  MAX_CONFIGURATION_FACT_VALUE_LENGTH,
} from '../../../src/cluster/Protocol.js';
import type { MemberData } from '../../../src/cluster/Protocol.js';

/**
 * The member-record half of #844 — the same shape `MemberStorageIdentities`
 * pins one field over, and for the same reasons: a gossiped value is a claim,
 * the type that owns the record is where the claim is checked, a status
 * transition must carry the claims through, and the overlay must not move the
 * merge clock.
 *
 * One thing here has no counterpart there, and it is the reason this file is
 * not a copy: the **keys** are peer-supplied too.  `storageIdentities` has
 * three field names written down in `src/`, so nothing off the wire decides
 * what gets assigned; a facts record is whatever the sender says it is, which
 * puts `__proto__` and every accessor on `Object.prototype` in reach of both
 * the write and the read.
 */

const ADDRESS = new NodeAddress('configuration-record', 'h', 4_712);

/** A record a hostile or broken peer could send, typed as the wire type. */
function gossipedWith(configurationFacts: unknown): MemberData {
  return {
    address: ADDRESS.toJSON(),
    status: 'up',
    version: 3,
    configurationFacts,
  } as unknown as MemberData;
}

describe('configuration facts on the member record', () => {
  test('round-trips through the gossiped form, omitted when absent', () => {
    const bare = new Member(ADDRESS, 'up', 3);
    expect('configurationFacts' in bare.toData()).toBe(false);

    const claiming = new Member(
      ADDRESS, 'up', 3, [], undefined, undefined,
      { 'actor-ts.remote.max-frame-bytes': '16777216' },
    );
    const data = claiming.toData();
    expect(data.configurationFacts).toEqual({ 'actor-ts.remote.max-frame-bytes': '16777216' });
    expect(Member.fromData(data).configurationFacts)
      .toEqual({ 'actor-ts.remote.max-frame-bytes': '16777216' });
  });

  test('the two overlays travel together, neither erasing the other', () => {
    // `toData` builds the wire record by spreading three times, and a spread
    // that dropped an earlier one would be invisible until a cluster ran both
    // #1358 and #844 at once — which is every cluster.
    const claiming = new Member(
      ADDRESS, 'up', 3, [], undefined,
      { journal: 'database-a' },
      { 'actor-ts.remote.max-frame-bytes': '16777216' },
    );

    const data = claiming.toData();

    expect(data.storageIdentities).toEqual({ journal: 'database-a' });
    expect(data.configurationFacts).toEqual({ 'actor-ts.remote.max-frame-bytes': '16777216' });
  });

  test('withStatus and withRemoved carry the claims — a promotion must not wipe them', () => {
    const facts = { 'actor-ts.remote.max-frame-bytes': '16777216' };
    const claiming = new Member(ADDRESS, 'joining', 3, [], undefined, undefined, facts);

    expect(claiming.withStatus('up').configurationFacts).toEqual(facts);
    expect(claiming.withRemoved(1_000).configurationFacts).toEqual(facts);
  });

  test('withConfigurationFacts keeps the merge clock still — claims ride an overlay lane', () => {
    // The trap `Cluster.publishStorageIdentity` documents: a self version bump
    // for an overlay claim races the leader's `joining → up` promotion to the
    // same `version + 1`, which `mergeMember` has no tie-break for.
    const member = new Member(ADDRESS, 'up', 3);

    const next = member.withConfigurationFacts({ 'actor-ts.remote.max-frame-bytes': '1048576' });

    expect(next.version).toBe(3);
    expect(next.status).toBe('up');
    expect(next.configurationFacts).toEqual({ 'actor-ts.remote.max-frame-bytes': '1048576' });
    expect(member.configurationFacts).toBeUndefined();
  });

  test('withConfigurationFacts keeps the storage identities, and the reverse', () => {
    // Two `with…` methods writing the same constructor argument list is how one
    // of them ends up passing `undefined` for the other's field.
    const member = new Member(ADDRESS, 'up', 3, [], undefined, { journal: 'database-a' });

    const withFacts = member.withConfigurationFacts({ 'actor-ts.remote.max-frame-bytes': '1048576' });
    expect(withFacts.storageIdentities).toEqual({ journal: 'database-a' });

    const backAgain = withFacts.withStorageIdentities({ journal: 'database-b' });
    expect(backAgain.configurationFacts).toEqual({ 'actor-ts.remote.max-frame-bytes': '1048576' });
  });

  test('wire claims are capped and type-checked; a bad entry drops, never the record', () => {
    const member = Member.fromData(gossipedWith({
      'actor-ts.remote.max-frame-bytes': '1048576',
      'actor-ts.cluster.tombstone.time-to-live': 'x'.repeat(MAX_CONFIGURATION_FACT_VALUE_LENGTH + 1),
      'actor-ts.cluster.gossip-interval': 1_000,
      ['n'.repeat(MAX_CONFIGURATION_FACT_NAME_LENGTH + 1)]: '1',
      'Actor-TS.Remote.Max-Frame-Bytes': '1',
      '': '1',
    }));

    expect(member.status).toBe('up');
    expect(member.configurationFacts).toEqual({ 'actor-ts.remote.max-frame-bytes': '1048576' });
  });

  test('the record is capped in count, not only per entry', () => {
    // Per-value caps bound each string and nothing bounds the record: the names
    // are the sender's to invent, so without this a peer makes every member
    // entry on every node carry as many of them as it likes.
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_CONFIGURATION_FACTS * 4; i++) many[`fact-${i}`] = String(i);

    const facts = Member.fromData(gossipedWith(many)).configurationFacts;

    expect(Object.keys(facts ?? {})).toHaveLength(MAX_CONFIGURATION_FACTS);
  });

  test('claims that are entirely garbage sanitize to absent', () => {
    expect(Member.fromData(gossipedWith(['not', 'an', 'object'])).configurationFacts)
      .toBeUndefined();
    expect(Member.fromData(gossipedWith(null)).configurationFacts).toBeUndefined();
    expect(Member.fromData(gossipedWith({ 'BAD NAME': 'v' })).configurationFacts).toBeUndefined();
  });

  test('a claim named __proto__ never reaches the record', () => {
    // The name pattern is what drops it, and this is the case that says so:
    // the value is a **string**, so it survives every other check and the only
    // thing standing between it and an own `__proto__` on the facts record is
    // the character set.
    //
    // Written as the pair of assertions rather than one, because they fail for
    // different reasons: `toEqual` catches the entry being kept, and the
    // prototype identity catches it being kept as a reparenting — the shape a
    // plain `[[Set]]` would produce if the value type were ever widened past
    // `string`.
    //
    // `JSON.parse`, not an object literal: `__proto__:` in a literal is the
    // prototype-setting syntax, so it would never produce the own property a
    // gossip frame actually carries.
    const member = Member.fromData(gossipedWith(
      JSON.parse('{"__proto__": "hostile", "actor-ts.remote.max-frame-bytes": "1"}'),
    ));
    const facts = member.configurationFacts as Record<string, unknown>;

    expect(facts).toEqual({ 'actor-ts.remote.max-frame-bytes': '1' });
    expect(Object.hasOwn(facts, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(facts)).toBe(Object.prototype);
  });
});
