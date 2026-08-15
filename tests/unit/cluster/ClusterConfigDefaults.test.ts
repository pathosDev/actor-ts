import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import {
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_TOMBSTONES,
  DEFAULT_SEED_RETRY_INTERVAL_MS,
  DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS,
  DEFAULT_TOMBSTONE_TTL_MS,
  isRemoteTlsRequested,
  readClusterOptionsFromConfig,
  withClusterConfigDefaults,
} from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { defaultFailureDetectorOptions } from '../../../src/cluster/FailureDetector.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../../../src/util/Constants.js';
import { DEFAULT_MAX_FRAME_BYTES } from '../../../src/cluster/Protocol.js';

describe('readClusterOptionsFromConfig', () => {
  test('reads the cluster block and the bind/wire settings under remote', () => {
    const config = Config.parseString(`
      actor-ts {
        cluster {
          gossip-interval     = 250ms
          seed-retry-interval = 1s
          failure-detector {
            heartbeat-interval = 100ms
            unreachable-after  = 400ms
            down-after         = 900ms
          }
        }
        remote {
          tcp { host = "10.0.0.7", port = 3551 }
          max-frame-bytes = 2M
        }
      }
    `);

    expect(readClusterOptionsFromConfig(config)).toEqual({
      host: '10.0.0.7',
      port: 3551,
      maxFrameBytes: 2 * 1024 * 1024,
      gossipIntervalMs: 250,
      seedRetryIntervalMs: 1_000,
      failureDetector: {
        heartbeatIntervalMs: 100,
        unreachableAfterMs: 400,
        downAfterMs: 900,
      },
    });
  });

  test('omits failureDetector entirely when no threshold is configured', () => {
    const config = Config.parseString('actor-ts.cluster.gossip-interval = 250ms');

    expect(readClusterOptionsFromConfig(config)).toEqual({ gossipIntervalMs: 250 });
  });

  test('an empty config yields no settings at all', () => {
    expect(readClusterOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // Wiring the block must not move any default, so the two are pinned
    // together here rather than trusted to stay in sync by eye.
    expect(readClusterOptionsFromConfig(Config.loadReference())).toEqual({
      host: '0.0.0.0',
      port: 2552,
      maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
      gossipIntervalMs: DEFAULT_GOSSIP_INTERVAL_MS,
      seedRetryIntervalMs: DEFAULT_SEED_RETRY_INTERVAL_MS,
      weaklyUpAfterMs: 0,
      maxMembers: DEFAULT_MAX_MEMBERS,
      maxTombstones: DEFAULT_MAX_TOMBSTONES,
      tombstoneTtlMs: DEFAULT_TOMBSTONE_TTL_MS,
      tombstonePruneIntervalMs: DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS,
      // 0 is the file's way of saying "derive from down-after"; the
      // derivation lives in the Cluster constructor, not here.
      tombstoneMinRetentionMs: 0,
      failureDetector: defaultFailureDetectorOptions,
    });
  });

  test('the housekeeping block reads through with its own values (#841)', () => {
    // The four knobs were code-only fields before — a deployment could not
    // move them into config at all, which is what #841 was filed for.
    const configured = Config.parseString(`
      actor-ts.cluster {
        weakly-up-after = 4s
        max-members     = 12
        max-tombstones  = 34
        tombstone {
          time-to-live   = 90m
          prune-interval = 30s
          min-retention  = 2s
        }
      }
    `);

    expect(readClusterOptionsFromConfig(configured)).toEqual({
      weaklyUpAfterMs: 4_000,
      maxMembers: 12,
      maxTombstones: 34,
      tombstoneTtlMs: 90 * 60 * 1_000,
      tombstonePruneIntervalMs: 30_000,
      tombstoneMinRetentionMs: 2_000,
    });
  });
});

describe('withClusterConfigDefaults', () => {
  const config = Config.parseString(`
    actor-ts {
      cluster {
        gossip-interval = 250ms
        failure-detector {
          heartbeat-interval = 100ms
          unreachable-after  = 400ms
          down-after         = 900ms
        }
      }
      remote.tcp { host = "10.0.0.7", port = 3551 }
    }
  `);

  test('explicit options win, unset ones fall through to the file', () => {
    const merged = withClusterConfigDefaults(config, { port: 9999 } as ClusterOptionsType);

    expect(merged.port).toBe(9999);
    expect(merged.host).toBe('10.0.0.7');
    expect(merged.gossipIntervalMs).toBe(250);
  });

  test('a partial failureDetector overrides one threshold and keeps the others', () => {
    // The nested case: a shallow merge would drop heartbeat + unreachable
    // back to the built-in defaults, discarding the file's values for
    // thresholds the caller never mentioned.
    const merged = withClusterConfigDefaults(
      config,
      { failureDetector: { downAfterMs: 1_500 } } as ClusterOptionsType,
    );

    expect(merged.failureDetector).toEqual({
      heartbeatIntervalMs: 100,
      unreachableAfterMs: 400,
      downAfterMs: 1_500,
    });
  });

  test('an explicit undefined threshold does not shadow the file', () => {
    const merged = withClusterConfigDefaults(
      config,
      { failureDetector: { downAfterMs: undefined } } as ClusterOptionsType,
    );

    expect(merged.failureDetector?.downAfterMs).toBe(900);
  });

  test('a config with no cluster block leaves the caller`s options untouched', () => {
    const options = { host: 'h', port: 1 } as ClusterOptionsType;

    expect(withClusterConfigDefaults(Config.empty(), options)).toEqual(options);
  });
});

/**
 * #591 — the predicate behind the startup warning.  It is the whole reason
 * `actor-ts.remote.tls.enabled` stopped being a dead key: nothing honours the
 * flag yet (#941), so reading it is all there is, and what the read is worth
 * lies entirely in when it answers `true`.
 */
describe('isRemoteTlsRequested', () => {
  test('an explicit true asks for TLS', () => {
    expect(isRemoteTlsRequested(Config.parseString('actor-ts.remote.tls.enabled = true'))).toBe(true);
  });

  test('an explicit false does not — it is what the shipped default says', () => {
    // The noise rule: a config file that spells the default out must behave
    // exactly like one that omits it, or every deployment that copied
    // reference.conf wholesale would warn.
    expect(isRemoteTlsRequested(Config.parseString('actor-ts.remote.tls.enabled = false'))).toBe(false);
  });

  test('the bundled reference defaults do not', () => {
    // The path is always present once the reference layer is loaded, so
    // presence cannot be the test — the value has to be.
    expect(Config.loadReference().hasPath('actor-ts.remote.tls.enabled')).toBe(true);
    expect(isRemoteTlsRequested(Config.loadReference())).toBe(false);
  });

  test('an absent key does not, and does not throw', () => {
    // `getBoolean` throws on a missing path, so the presence check in front of
    // it is load-bearing rather than decorative.
    expect(isRemoteTlsRequested(Config.empty())).toBe(false);
  });

  test('HOCON booleans spelled as words are honoured', () => {
    // `on` / `off` are HOCON's own boolean spellings; an operator who writes
    // `on` asked for TLS just as clearly as one who wrote `true`.
    expect(isRemoteTlsRequested(Config.parseString('actor-ts.remote.tls.enabled = on'))).toBe(true);
    expect(isRemoteTlsRequested(Config.parseString('actor-ts.remote.tls.enabled = off'))).toBe(false);
  });

  test('it stays out of the merged cluster options', () => {
    // There is no `ClusterOptionsType` field for it to land in, and there must
    // not be one until something honours it: an option that reads back the
    // value it was given while changing nothing is worse than none at all.
    const configured = Config.parseString('actor-ts.remote.tls.enabled = true');

    expect(readClusterOptionsFromConfig(configured)).toEqual({});
    // Keys rather than the whole object: the merge returns a
    // `ClusterOptionsType`, and comparing it against a bare `{}` is a type
    // error even when the value is right.
    expect(Object.keys(withClusterConfigDefaults(configured, {} as ClusterOptionsType))).toEqual([]);
  });
});
