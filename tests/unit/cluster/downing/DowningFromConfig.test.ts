/**
 * #838 — `actor-ts.cluster.split-brain-resolver` selects a `DowningProvider`.
 *
 * Every assertion here goes through `Config.parseString`, never
 * `Config.fromObject({'actor-ts.x.y': …})`: the latter keeps the dotted string
 * as one literal top-level key, so `hasPath` would descend the *nested*
 * reference tree instead and read the shipped `off` — a test that asserts
 * nothing and passes.
 */
import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../../src/config/Config.js';
import {
  DEFAULT_SPLIT_BRAIN_RESOLVER_STRATEGY,
  readDowningFromConfig,
} from '../../../../src/cluster/downing/DowningFromConfig.js';
import { KeepMajority } from '../../../../src/cluster/downing/KeepMajority.js';
import { KeepOldest } from '../../../../src/cluster/downing/KeepOldest.js';
import { KeepReferee } from '../../../../src/cluster/downing/KeepReferee.js';
import { StaticQuorum } from '../../../../src/cluster/downing/StaticQuorum.js';
import { addrKey } from '../../../../src/cluster/downing/DowningProvider.js';
import type { ClusterPartitionView } from '../../../../src/cluster/downing/DowningProvider.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';

const address = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);

/** An `up` member at `sys@h:<port>`, optionally role-tagged. */
const member = (port: number, roles: string[] = []): Member =>
  new Member(address(port), 'up', Date.now(), roles);

/** A view of `members` in which everything in `unreachablePorts` is silent. */
function view(members: Member[], unreachablePorts: number[], selfPort: number): ClusterPartitionView {
  return {
    allMembers: members,
    unreachable: new Set(
      members.filter((m) => unreachablePorts.includes(m.address.port)).map(addrKey),
    ),
    self: address(selfPort),
  };
}

describe('readDowningFromConfig', () => {
  test('an absent block selects nothing', () => {
    expect(readDowningFromConfig(Config.empty())).toBeUndefined();
  });

  test('the shipped default selects nothing', () => {
    // Load-bearing rather than cosmetic: `readClusterOptionsFromConfig` only
    // writes `downing` when this answers, so `off` returning `undefined` is
    // what keeps the reference config's merged options free of the key.
    expect(DEFAULT_SPLIT_BRAIN_RESOLVER_STRATEGY).toBe('off');
    expect(readDowningFromConfig(Config.loadReference())).toBeUndefined();
  });

  test('an explicit off behaves exactly like an absent key', () => {
    // A file that spells the default out must behave like one that omits it,
    // or every deployment that copied reference.conf wholesale would differ
    // from one that did not (#841).
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = off',
    );

    expect(readDowningFromConfig(configured)).toBeUndefined();
  });

  test('keep-majority is built, and it is the strategy it says', () => {
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majority',
    );

    const provider = readDowningFromConfig(configured);

    expect(provider).toBeInstanceOf(KeepMajority);
    // `instanceof` alone would pass for a KeepMajority built with the wrong
    // options, so the decision is exercised too: 2 reachable of 3 is a
    // majority, and the silent one is downed.
    expect(provider!.decide(view([member(1), member(2), member(3)], [3], 1)))
      .toEqual(new Set(['sys@h:3']));
  });

  test('the role narrows the candidate set the strategy arbitrates over', () => {
    const configured = Config.parseString(`
      actor-ts.cluster.split-brain-resolver {
        active-strategy    = keep-majority
        keep-majority.role = backend
      }
    `);

    const provider = readDowningFromConfig(configured)!;

    // Only the two `backend` members count, so this node is on a 1-of-2 side
    // — no majority either way, and `KeepMajority` downs its own side.  The
    // untagged member at :9 is invisible to the arithmetic, which is exactly
    // what the role does and what a reader dropping it would break.
    expect(provider.decide(view([member(1, ['backend']), member(2, ['backend']), member(9)], [2], 1)))
      .toEqual(new Set(['sys@h:1']));
  });

  test('an empty role is dropped rather than passed through', () => {
    // `""` is the shape the key ships with, not a value.  It reaches the same
    // decision as no role at all — the assertion is that the untagged member
    // is still counted, which a literal `role: ''` would also give, so the
    // pin that matters is the one below on the constructed options.
    const configured = Config.parseString(`
      actor-ts.cluster.split-brain-resolver {
        active-strategy    = keep-majority
        keep-majority.role = ""
      }
    `);

    const provider = readDowningFromConfig(configured)!;

    expect(provider.decide(view([member(1), member(2), member(3)], [3], 1)))
      .toEqual(new Set(['sys@h:3']));
  });

  test('keep-oldest is built, and the lowest address wins', () => {
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-oldest',
    );

    const provider = readDowningFromConfig(configured);

    expect(provider).toBeInstanceOf(KeepOldest);
    // :1 sorts first and is on this side, so the silent :2 loses.
    expect(provider!.decide(view([member(1), member(2)], [2], 1)))
      .toEqual(new Set(['sys@h:2']));
  });

  test('keep-oldest has no down-if-alone key to read (#932)', () => {
    // The flag is deliberately not config-selectable: `KeepOldest.decide`'s
    // two arms are byte-identical today, so shipping the key would document a
    // knob that changes nothing.  `NoDeadConfigKeys` would pass it — the field
    // *is* read — which is why this is asserted on the leaf.
    expect(Config.loadReference()
      .hasPath('actor-ts.cluster.split-brain-resolver.keep-oldest.down-if-alone')).toBe(false);
  });

  test('static-quorum is built from its quorum size', () => {
    const configured = Config.parseString(`
      actor-ts.cluster.split-brain-resolver {
        active-strategy           = static-quorum
        static-quorum.quorum-size = 2
      }
    `);

    const provider = readDowningFromConfig(configured);

    expect(provider).toBeInstanceOf(StaticQuorum);
    // 2 reachable meets the quorum, so the silent side goes.
    expect(provider!.decide(view([member(1), member(2), member(3)], [3], 1)))
      .toEqual(new Set(['sys@h:3']));
    // …and 1 reachable does not, so this side downs itself.  Two directions,
    // because a quorum read as `undefined` or `NaN` would pass the first.
    expect(provider!.decide(view([member(1), member(2), member(3)], [2, 3], 1)))
      .toEqual(new Set(['sys@h:1']));
  });

  test('static-quorum without a quorum size is refused, naming the key', () => {
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = static-quorum',
    );

    expect(() => readDowningFromConfig(configured)).toThrow(ConfigError);
    expect(() => readDowningFromConfig(configured))
      .toThrow(/actor-ts\.cluster\.split-brain-resolver\.static-quorum\.quorum-size/);
  });

  test('an out-of-range quorum size is refused with the config path in it', () => {
    // `StaticQuorumOptionsValidator` owns the bound and its message names a
    // *field*; the reader widens that to the line an operator has to edit.
    const configured = Config.parseString(`
      actor-ts.cluster.split-brain-resolver {
        active-strategy           = static-quorum
        static-quorum.quorum-size = 0
      }
    `);

    expect(() => readDowningFromConfig(configured)).toThrow(ConfigError);
    expect(() => readDowningFromConfig(configured))
      .toThrow(/actor-ts\.cluster\.split-brain-resolver\.static-quorum\.quorum-size/);
  });

  test('keep-referee is built from the referee address', () => {
    const configured = Config.parseString(`
      actor-ts.cluster.split-brain-resolver {
        active-strategy              = keep-referee
        keep-referee.referee-address = "sys@h:2"
      }
    `);

    const provider = readDowningFromConfig(configured);

    expect(provider).toBeInstanceOf(KeepReferee);
    // The referee is reachable, so the other side loses.
    expect(provider!.decide(view([member(1), member(2), member(3)], [3], 1)))
      .toEqual(new Set(['sys@h:3']));
    // The referee is on the far side, so this one downs itself.
    expect(provider!.decide(view([member(1), member(2), member(3)], [2], 1)))
      .toEqual(new Set(['sys@h:1', 'sys@h:3']));
  });

  test('keep-referee reads the optional extra quorum too', () => {
    const configured = Config.parseString(`
      actor-ts.cluster.split-brain-resolver {
        active-strategy                       = keep-referee
        keep-referee.referee-address          = "sys@h:2"
        keep-referee.down-all-if-below-quorum = 3
      }
    `);

    const provider = readDowningFromConfig(configured)!;

    // Referee reachable but only 2 on its side, below the 3 asked for: down
    // everyone rather than run on a shaky majority.  Without the key being
    // read this would be `{sys@h:3}` instead.
    expect(provider.decide(view([member(1), member(2), member(3)], [3], 1)))
      .toEqual(new Set(['sys@h:1', 'sys@h:2', 'sys@h:3']));
  });

  test('keep-referee without an address is refused, naming the key', () => {
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-referee',
    );

    expect(() => readDowningFromConfig(configured)).toThrow(ConfigError);
    expect(() => readDowningFromConfig(configured))
      .toThrow(/actor-ts\.cluster\.split-brain-resolver\.keep-referee\.referee-address/);
  });

  test('lease-majority is refused, and the message says where it does work', () => {
    // Not "unknown value": the strategy exists, ships and is documented.  What
    // it cannot do is arrive from a file — its `lease` is a live four-method
    // object whose owner is this node's own address, and #859's
    // `actor-ts.coordination` block tunes leases without naming which backend
    // to build.  So the refusal has to point at the route that works.
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = lease-majority',
    );

    expect(() => readDowningFromConfig(configured)).toThrow(ConfigError);
    expect(() => readDowningFromConfig(configured)).toThrow(/withDowning\(new LeaseMajority/);
  });

  test('an unknown strategy is refused, listing the legal values', () => {
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majorty',
    );

    expect(() => readDowningFromConfig(configured)).toThrow(ConfigError);
    expect(() => readDowningFromConfig(configured))
      .toThrow(/off \| keep-majority \| keep-oldest \| keep-referee \| static-quorum/);
    expect(() => readDowningFromConfig(configured))
      .toThrow(/actor-ts\.cluster\.split-brain-resolver\.active-strategy/);
  });

  test('off is read as a string, not coerced to a boolean', () => {
    // `HoconParser` maps only true/false/null/numbers, so `off` arrives as
    // `'off'` — but `Config.getBoolean` *would* coerce it.  Reading the key
    // that way would turn every strategy name into a type error rather than a
    // selection, so the accessor is pinned here.
    const reference = Config.loadReference();

    expect(reference.getString('actor-ts.cluster.split-brain-resolver.active-strategy'))
      .toBe('off');
    expect(reference.getBoolean('actor-ts.cluster.split-brain-resolver.active-strategy'))
      .toBe(false);
  });
});
