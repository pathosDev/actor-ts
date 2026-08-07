import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import {
  readClusterOptionsFromConfig,
  withClusterConfigDefaults,
} from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { defaultFailureDetectorOptions } from '../../../src/cluster/FailureDetector.js';
import { DEFAULT_MAX_MEMBERS, DEFAULT_MAX_TOMBSTONES } from '../../../src/cluster/Cluster.js';
import {
  DEFAULT_GOSSIP_INTERVAL_MS,
  DEFAULT_SEED_RETRY_INTERVAL_MS,
  DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS,
  DEFAULT_TOMBSTONE_TTL_MS,
} from '../../../src/util/Constants.js';
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
