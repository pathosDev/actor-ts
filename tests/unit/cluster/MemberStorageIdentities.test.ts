import { describe, expect, test } from 'bun:test';

import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { MAX_STORAGE_IDENTITY_LENGTH } from '../../../src/cluster/Protocol.js';
import type { MemberData } from '../../../src/cluster/Protocol.js';

/**
 * The member-record half of #1358.  What matters here is the same wire
 * posture #563 established for `status` and #940 for the incarnation: a
 * gossiped value is a claim, and the type that owns the record is where the
 * claim is checked.  Plus the two threading properties everything else rests
 * on — a status transition must carry the claims (a leader promotion is
 * merged wholesale), and an identity update must bump the version or the
 * merge clock ignores it.
 */

const ADDRESS = new NodeAddress('identity-record', 'h', 4_711);

describe('storage identities on the member record', () => {
  test('round-trips through the gossiped form, omitted when absent', () => {
    const bare = new Member(ADDRESS, 'up', 3);
    expect('storageIdentities' in bare.toData()).toBe(false);

    const claiming = new Member(ADDRESS, 'up', 3, [], undefined, { journal: 'database-a' });
    const data = claiming.toData();
    expect(data.storageIdentities).toEqual({ journal: 'database-a' });
    expect(Member.fromData(data).storageIdentities).toEqual({ journal: 'database-a' });
  });

  test('withStatus and withRemoved carry the claims — a promotion must not wipe them', () => {
    const claiming = new Member(ADDRESS, 'joining', 3, [], undefined, { journal: 'database-a' });
    expect(claiming.withStatus('up').storageIdentities).toEqual({ journal: 'database-a' });
    expect(claiming.withRemoved(1_000).storageIdentities).toEqual({ journal: 'database-a' });
  });

  test('withStorageIdentities keeps the merge clock still — claims ride an overlay lane', () => {
    // A version bump here raced the leader's status transitions to the same
    // `version + 1`, which has no tie-break — the wedge the sharding suite
    // caught the day this field bumped.
    const member = new Member(ADDRESS, 'up', 3);

    const next = member.withStorageIdentities({ journal: 'database-a' });

    expect(next.version).toBe(3);
    expect(next.status).toBe('up');
    expect(next.storageIdentities).toEqual({ journal: 'database-a' });
    // The original is immutable, like every other `with…`.
    expect(member.storageIdentities).toBeUndefined();
  });

  test('wire claims are capped and type-checked; a bad field drops, never the record', () => {
    const data = {
      address: ADDRESS.toJSON(),
      status: 'up',
      version: 3,
      storageIdentities: {
        journal: 'database-a',
        snapshotStore: 'x'.repeat(MAX_STORAGE_IDENTITY_LENGTH + 1),
        durableStateStore: 42,
      },
    } as unknown as MemberData;

    const member = Member.fromData(data);

    expect(member.status).toBe('up');
    expect(member.storageIdentities).toEqual({ journal: 'database-a' });
  });

  test('claims that are entirely garbage sanitize to absent', () => {
    const data = {
      address: ADDRESS.toJSON(),
      status: 'up',
      version: 3,
      storageIdentities: ['not', 'an', 'object'],
    } as unknown as MemberData;

    expect(Member.fromData(data).storageIdentities).toBeUndefined();
  });
});
