import { describe, expect, test } from 'bun:test';

import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { MAX_APP_VERSION_LENGTH } from '../../../src/cluster/Protocol.js';
import type { MemberData } from '../../../src/cluster/Protocol.js';
import { wireFrameProblem } from '../../../src/cluster/WireValidation.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #843 — the application version a member states, for an operator to read
 * while a rolling update has old and new code in one cluster.
 *
 * Advisory and nothing else: nothing places, routes or downs on it.  What it
 * has to be is *true* and *harmless*, which is why most of what is pinned
 * here is about where a label comes from and what one may contain — it is
 * printed by `Member.toString`, by every log line that prints a member and by
 * `/cluster/members`, and a peer's label arrives off the wire.
 */

describe('the validator holds the label to what every peer admits', () => {
  const validate = (appVersion: unknown): void => {
    new ClusterOptionsValidator().validate({ appVersion } as Partial<ClusterOptionsType>);
  };

  test('the shapes version schemes actually use pass', () => {
    const labels = [
      '1.2.3',
      'v2.4.0-rc.1+build.5',
      '2026.10.15',
      'a1b2c3d',
      'release/1.2',
      'registry.example.com/orders:1.2.3',
      '1.2.3_hotfix',
      'x'.repeat(MAX_APP_VERSION_LENGTH),
    ];
    for (const label of labels) expect(() => validate(label), label).not.toThrow();
    expect(() => validate(undefined)).not.toThrow();
  });

  test('an empty label is refused rather than stated as nothing', () => {
    // What `${?APP_VERSION}` lands over a variable that is set to nothing.
    // Stating no version already has a spelling — an absent key — so an empty
    // one is a deployment that meant to set it and did not.
    expect(() => validate('')).toThrow(OptionsError);
  });

  test('a label over the cap is refused here, not dropped by every peer', () => {
    expect(() => validate('x'.repeat(MAX_APP_VERSION_LENGTH + 1))).toThrow(OptionsError);
  });

  test('a label that could forge or disguise a log line is refused', () => {
    // Control characters end a log line early or rewrite it; whitespace makes
    // two labels that print alike compare unequal; a bidi override reorders
    // what a terminal shows.  Visible ASCII has none of the three.
    const labels = [
      '1.2.3\nERROR forged line',
      '1.2.3\r',
      '1.2.3\t',
      '1.2.3 ',
      ' 1.2.3',
      '1.2.3 (build 42)',
      '1.2.3\u0000',
      '1.2.3\u007f',
      '1.2.3‮',
      'versión-1',
    ];
    for (const label of labels) expect(() => validate(label), JSON.stringify(label)).toThrow(OptionsError);
  });

  test('a value that is not a string is refused', () => {
    expect(() => validate(42)).toThrow(OptionsError);
  });

  test('the refusal names the field and says what a legal label looks like', () => {
    expect(() => validate('1.2.3\n')).toThrow(/appVersion/);
    expect(() => validate('1.2.3\n')).toThrow(new RegExp(`${MAX_APP_VERSION_LENGTH}`));
  });

  test('the builder sets the field the reader and the validator use', () => {
    const clusterOptions = ClusterOptions.create().withAppVersion('2.4.0');

    expect((clusterOptions as Partial<ClusterOptionsType>).appVersion).toBe('2.4.0');
  });
});

const ADDRESS = new NodeAddress('app-version-record', 'h', 4_713);

/** A record a hostile or broken peer could send, typed as the wire type. */
function gossipedWith(appVersion: unknown): MemberData {
  return {
    address: ADDRESS.toJSON(),
    status: 'up',
    version: 3,
    roles: ['backend'],
    appVersion,
  } as unknown as MemberData;
}

describe('the app version on the member record', () => {
  test('round-trips through the gossiped form, omitted when absent', () => {
    const bare = new Member(ADDRESS, 'up', 3);
    expect('appVersion' in bare.toData()).toBe(false);

    const stating = new Member(ADDRESS, 'up', 3, [], undefined, undefined, undefined, '2.4.0');
    const data = stating.toData();
    expect(data.appVersion).toBe('2.4.0');
    expect(Member.fromData(data).appVersion).toBe('2.4.0');
  });

  test('travels beside both overlays, none of the three erasing another', () => {
    // `toData` assembles the record by spreading one optional field at a time,
    // and a spread that dropped an earlier one would stay invisible until a
    // cluster ran all three at once.
    const member = new Member(
      ADDRESS, 'up', 3, [], undefined,
      { journal: 'database-a' },
      { 'actor-ts.remote.max-frame-bytes': '16777216' },
      '2.4.0',
    );

    expect(member.toData()).toEqual({
      address: ADDRESS.toJSON(),
      status: 'up',
      version: 3,
      roles: [],
      storageIdentities: { journal: 'database-a' },
      configurationFacts: { 'actor-ts.remote.max-frame-bytes': '16777216' },
      appVersion: '2.4.0',
    });
  });

  test('every constructor path carries it — a promotion or an overlay write must not wipe it', () => {
    // A leader's promotion is merged wholesale on every peer, so a status
    // transition that dropped the label would take it off the cluster's view
    // at the exact moment a rolling update makes it worth reading.
    const stating = new Member(ADDRESS, 'joining', 3, ['backend'], undefined, undefined, undefined, '2.4.0');

    expect(stating.withStatus('up').appVersion).toBe('2.4.0');
    expect(stating.withRemoved(1_000).appVersion).toBe('2.4.0');
    expect(stating.withStorageIdentities({ journal: 'database-a' }).appVersion).toBe('2.4.0');
    expect(stating.withConfigurationFacts({ 'actor-ts.remote.max-frame-bytes': '1' }).appVersion).toBe('2.4.0');
  });

  test('withAppVersion keeps the merge clock still and every other field', () => {
    // The label rides the overlay lane beside the two claims, for their
    // reason: a version bump would race the leader's `joining → up` promotion
    // to the same `version + 1`, which `mergeMember` has no tie-break for.
    const member = new Member(
      ADDRESS, 'up', 3, ['backend'], undefined,
      { journal: 'database-a' },
      { 'actor-ts.remote.max-frame-bytes': '1' },
    );

    const next = member.withAppVersion('2.4.0');

    expect(next.version).toBe(3);
    expect(next.status).toBe('up');
    expect([...next.roles]).toEqual(['backend']);
    expect(next.storageIdentities).toEqual({ journal: 'database-a' });
    expect(next.configurationFacts).toEqual({ 'actor-ts.remote.max-frame-bytes': '1' });
    expect(next.appVersion).toBe('2.4.0');
    expect(member.appVersion).toBeUndefined();
  });

  test('a bad label off the wire drops, never the record', () => {
    // The label is advisory and the member is not: refusing the record would
    // let one malformed label suppress a peer's whole membership.
    const labels: unknown[] = [
      42,
      '',
      'x'.repeat(MAX_APP_VERSION_LENGTH + 1),
      '1.2.3\nERROR forged line',
      '1.2.3 ',
      '1.2.3‮',
      ['2.4.0'],
      { major: 2 },
      null,
    ];
    for (const label of labels) {
      const member = Member.fromData(gossipedWith(label));

      expect(member.status, JSON.stringify(label)).toBe('up');
      expect([...member.roles], JSON.stringify(label)).toEqual(['backend']);
      expect(member.appVersion, JSON.stringify(label)).toBeUndefined();
    }
  });

  test('the cap admits a label of exactly the cap', () => {
    const longest = 'x'.repeat(MAX_APP_VERSION_LENGTH);

    expect(Member.fromData(gossipedWith(longest)).appVersion).toBe(longest);
  });

  test('a frame is not refused for the label it carries', () => {
    // The frame guard checks what the merge cannot do without, and a label is
    // not that; turning a bad one into a refused frame would drop every record
    // beside it.  `Member.fromData` is where it is dropped instead.
    const frame = {
      kind: 'gossip',
      from: ADDRESS.toJSON(),
      sequence: 1,
      members: [gossipedWith(42), gossipedWith('1.2.3\nERROR forged line')],
    };

    expect(wireFrameProblem(frame)).toBeNull();
  });

  test('toString prints the label, and nothing for a member that states none', () => {
    expect(new Member(ADDRESS, 'up', 3, ['backend'], undefined, undefined, undefined, '2.4.0').toString())
      .toBe('Member(app-version-record@h:4713, up, v3 roles=[backend] app-version=2.4.0)');
    expect(new Member(ADDRESS, 'up', 3, ['backend']).toString())
      .toBe('Member(app-version-record@h:4713, up, v3 roles=[backend])');
  });
});
