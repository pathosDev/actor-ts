import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import {
  DEFAULT_FAILURE_DETECTOR_IMPLEMENTATION,
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_TOMBSTONES,
  DEFAULT_SEED_RETRY_INTERVAL_MS,
  DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS,
  DEFAULT_TOMBSTONE_TTL_MS,
  DEFAULT_UNTRUSTED_MODE,
  isRemoteTlsRequested,
  readClusterOptionsFromConfig,
  withClusterConfigDefaults,
} from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { KeepMajority } from '../../../src/cluster/downing/KeepMajority.js';
import { KeepOldest } from '../../../src/cluster/downing/KeepOldest.js';
import { defaultFailureDetectorOptions } from '../../../src/cluster/FailureDetector.js';
import { defaultPhiAccrualOptions } from '../../../src/cluster/PhiAccrualFailureDetector.js';
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

  test('reads the advertised host, which the bind host does not stand in for', () => {
    // Two keys because they are two facts: what to bind and what to tell peers
    // to dial (#944).  Only the second may not be a wildcard.
    const config = Config.parseString(`
      actor-ts.remote.tcp {
        host           = "0.0.0.0"
        advertised-host = "10.0.0.7"
      }
    `);

    expect(readClusterOptionsFromConfig(config))
      .toEqual({ host: '0.0.0.0', advertisedHost: '10.0.0.7' });
  });

  test('advertisedHost is absent when the key is, so "unset" stays expressible', () => {
    // It ships no leaf in `reference.conf` on purpose: a key that is always
    // present could not mean "derive it from `host`", which is what every
    // deployment that names one routable host relies on.
    const config = Config.parseString('actor-ts.remote.tcp.host = "10.0.0.7"');

    expect(readClusterOptionsFromConfig(config)).toEqual({ host: '10.0.0.7' });
    expect(Config.loadReference().hasPath('actor-ts.remote.tcp.advertised-host')).toBe(false);
  });

  test('reads the advertised port, which the bind port does not stand in for', () => {
    // The same two facts one axis over (#845): the port bound, and the port
    // peers dial.  They differ exactly where a deployment published the
    // process on a different one.
    const config = Config.parseString(`
      actor-ts.remote.tcp {
        port           = 2552
        advertised-port = 3000
      }
    `);

    expect(readClusterOptionsFromConfig(config))
      .toEqual({ port: 2552, advertisedPort: 3000 });
  });

  test('advertisedPort is absent when the key is, so "unset" stays expressible', () => {
    // It ships no leaf in `reference.conf` for the reason `advertised-host`
    // does not: a key that is always present could not mean "the same as
    // `port`", which is what every deployment that does not remap it relies
    // on.
    const config = Config.parseString('actor-ts.remote.tcp.port = 2552');

    expect(readClusterOptionsFromConfig(config)).toEqual({ port: 2552 });
    expect(Config.loadReference().hasPath('actor-ts.remote.tcp.advertised-port')).toBe(false);
  });

  test('omits failureDetector entirely when no threshold is configured', () => {
    const config = Config.parseString('actor-ts.cluster.gossip-interval = 250ms');

    expect(readClusterOptionsFromConfig(config)).toEqual({ gossipIntervalMs: 250 });
  });

  test('reads the detector selector and the whole φ sub-block (#840)', () => {
    const config = Config.parseString(`
      actor-ts.cluster.failure-detector {
        implementation = phi
        phi {
          unreachable-threshold      = 8.5
          down-threshold             = 16
          max-sample-size            = 42
          min-std-deviation          = 250ms
          acceptable-heartbeat-pause = 3s
        }
      }
    `);

    expect(readClusterOptionsFromConfig(config)).toEqual({
      failureDetectorImplementation: 'phi',
      phiAccrual: {
        // Fractional on purpose: φ is a continuous score, and `getInt` would
        // throw on this value — which is what pins the reader to `getNumber`.
        unreachableThreshold: 8.5,
        downThreshold: 16,
        maxSampleSize: 42,
        minStdDeviationMs: 250,
        acceptableHeartbeatPauseMs: 3_000,
      },
    });
  });

  test('omits phiAccrual entirely when no φ setting is configured', () => {
    // Same rule as `failureDetector` one block over: an absent leaf has to
    // fall through to the built-in default, not land as an explicit value.
    const config = Config.parseString('actor-ts.cluster.failure-detector.unreachable-after = 400ms');

    expect(readClusterOptionsFromConfig(config))
      .toEqual({ failureDetector: { unreachableAfterMs: 400 } });
  });

  test('a φ leaf on its own is read without the selector', () => {
    // The two are independent keys: tuning the block without switching to it
    // is legitimate (stage the values, flip `implementation` later), and a
    // reader that only looked at `phi` when `implementation = phi` would
    // silently drop them.
    const config = Config.parseString('actor-ts.cluster.failure-detector.phi.down-threshold = 20');

    expect(readClusterOptionsFromConfig(config)).toEqual({ phiAccrual: { downThreshold: 20 } });
  });

  test('an empty config yields no settings at all', () => {
    expect(readClusterOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('a named split-brain strategy arrives as a built provider (#838)', () => {
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majority',
    );

    const read = readClusterOptionsFromConfig(configured);

    // The whole object, not just the one key: a reader that also punched in a
    // default for the three `role` leaves would still satisfy an assertion on
    // `downing` alone, and this shape is what `Cluster.join` merges.
    expect(Object.keys(read)).toEqual(['downing']);
    expect(read.downing).toBeInstanceOf(KeepMajority);
  });

  test('active-strategy = off leaves no downing key at all (#838)', () => {
    // Asserted on both spellings for the reason `min-retention` is: an
    // explicit default must behave like an omitted one, and an explicit
    // `downing: undefined` would still be a key that the merge then has to
    // strip rather than never see.
    expect(readClusterOptionsFromConfig(
      Config.parseString('actor-ts.cluster.split-brain-resolver.active-strategy = off'),
    )).not.toHaveProperty('downing');
    expect(readClusterOptionsFromConfig(Config.loadReference()))
      .not.toHaveProperty('downing');
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
      // Both leaves ship a value, so both always land here — and the shipped
      // pair is the open one: any /user actor addressable by name, which is
      // what an ActorRef across nodes needs.  /system is refused either way and
      // has no leaf at all, deliberately (#877, #964).
      untrustedMode: DEFAULT_UNTRUSTED_MODE,
      trustedSelectionPaths: [],
      failureDetectorImplementation: DEFAULT_FAILURE_DETECTOR_IMPLEMENTATION,
      failureDetector: defaultFailureDetectorOptions,
      // Field by field rather than against `defaultPhiAccrualOptions` whole:
      // that object also carries `heartbeatIntervalMs`, and the φ block has no
      // leaf for it on purpose — the cadence comes from
      // `failure-detector.heartbeat-interval` for either implementation
      // (#1142).  Pinning the whole object would demand a leaf that must not
      // exist.
      phiAccrual: {
        unreachableThreshold: defaultPhiAccrualOptions.unreachableThreshold,
        downThreshold: defaultPhiAccrualOptions.downThreshold,
        maxSampleSize: defaultPhiAccrualOptions.maxSampleSize,
        minStdDeviationMs: defaultPhiAccrualOptions.minStdDeviationMs,
        acceptableHeartbeatPauseMs: defaultPhiAccrualOptions.acceptableHeartbeatPauseMs,
      },
    });
  });

  test('the reference φ block carries no heartbeat interval of its own (#1142)', () => {
    // The trap this guards: a `failure-detector.phi.heartbeat-interval` would
    // let switching the implementation silently change how often the node
    // talks to its peers, which is the drift aff9d371 collapsed onto one
    // constant.  Asserted on the leaf rather than on the reader, because a
    // leaf nothing reads is exactly what the guard has to catch.
    expect(Config.loadReference().hasPath('actor-ts.cluster.failure-detector.phi.heartbeat-interval'))
      .toBe(false);
    expect(readClusterOptionsFromConfig(Config.loadReference()).phiAccrual)
      .not.toHaveProperty('heartbeatIntervalMs');
  });

  test('the two wire-trust keys read through, list and all (#877)', () => {
    // `Config.parseString`, never `Config.fromObject` with a dotted key: that
    // keeps the dotted string as a literal top-level key, so `hasPath` would
    // resolve the *reference* value instead and the assertion would be about
    // the shipped default rather than about this file.
    const configured = Config.parseString(`
      actor-ts.remote {
        untrusted-mode          = true
        trusted-selection-paths = ["/user/orders/*", "/user/reporting/intake"]
      }
    `);

    expect(readClusterOptionsFromConfig(configured)).toEqual({
      untrustedMode: true,
      trustedSelectionPaths: ['/user/orders/*', '/user/reporting/intake'],
    });
  });

  test('an explicit allow-list wins over the file, an unset one falls through (#877)', () => {
    const configured = Config.parseString(
      'actor-ts.remote.trusted-selection-paths = ["/user/from-config"]',
    );

    expect(withClusterConfigDefaults(configured, {} as ClusterOptionsType).trustedSelectionPaths)
      .toEqual(['/user/from-config']);
    expect(withClusterConfigDefaults(
      configured,
      { host: 'h', port: 1, trustedSelectionPaths: ['/user/from-code'] } as ClusterOptionsType,
    ).trustedSelectionPaths).toEqual(['/user/from-code']);
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

  test('a partial phiAccrual overrides one field and keeps the other four (#840)', () => {
    // The trap the second nested pass exists for: `mergeOptions` is shallow,
    // so without it an explicit `{ downThreshold }` replaces the whole object
    // and the file's other four φ settings silently revert to the built-in
    // defaults — settings the caller never mentioned.
    const configured = Config.parseString(`
      actor-ts.cluster.failure-detector.phi {
        unreachable-threshold      = 9
        down-threshold             = 14
        max-sample-size            = 64
        min-std-deviation          = 300ms
        acceptable-heartbeat-pause = 2s
      }
    `);

    const merged = withClusterConfigDefaults(
      configured,
      { phiAccrual: { downThreshold: 20 } } as ClusterOptionsType,
    );

    expect(merged.phiAccrual).toEqual({
      unreachableThreshold: 9,
      downThreshold: 20,
      maxSampleSize: 64,
      minStdDeviationMs: 300,
      acceptableHeartbeatPauseMs: 2_000,
    });
  });

  test('an explicit implementation wins over the file, and an unset one falls through', () => {
    const configured = Config.parseString('actor-ts.cluster.failure-detector.implementation = phi');

    expect(withClusterConfigDefaults(configured, {} as ClusterOptionsType)
      .failureDetectorImplementation).toBe('phi');
    expect(withClusterConfigDefaults(
      configured,
      { failureDetectorImplementation: 'simple' } as ClusterOptionsType,
    ).failureDetectorImplementation).toBe('simple');
  });

  test('an explicit withDowning wins over the configured strategy (#838)', () => {
    // The precedence the block needs and does not implement: `mergeOptions`
    // strips `undefined` from the explicit layer, so a caller who named a
    // provider keeps it and a caller who named none inherits the file's.
    const configured = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majority',
    );
    const inCode = new KeepOldest();
    const joinOptions = (downing?: KeepOldest): ClusterOptionsType =>
      ({ host: 'h', port: 1, downing }) as ClusterOptionsType;

    expect(withClusterConfigDefaults(configured, joinOptions(inCode)).downing).toBe(inCode);
    expect(withClusterConfigDefaults(configured, {} as ClusterOptionsType).downing)
      .toBeInstanceOf(KeepMajority);
    // …and an explicit `undefined` is "not set", not "explicitly none".
    expect(withClusterConfigDefaults(configured, joinOptions()).downing)
      .toBeInstanceOf(KeepMajority);
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
    expect(isRemoteTlsRequested(Config.parseString('actor-ts.remote.tls.enabled = yes'))).toBe(true);
    expect(isRemoteTlsRequested(Config.parseString('actor-ts.remote.tls.enabled = no'))).toBe(false);
  });

  test.each([
    ['a word that is not a boolean', 'maybe'],
    ['a numeric truthy', '1'],
    ['a quoted numeric', '"0"'],
  ])('%s is rejected rather than guessed at', (_case, value) => {
    // The decision behind the throw, pinned so it cannot be softened by
    // accident: reading a *security* toggle tolerantly means picking one of
    // two defensible guesses, and the "not the literal true" guess silently
    // returns the node to plaintext-while-configured-for-TLS — the state #591
    // exists to make impossible.  Refusing is also just what every other typed
    // key does, so an operator who mistypes this one is not surprised twice.
    const configured = Config.parseString(`actor-ts.remote.tls.enabled = ${value}`);

    expect(() => isRemoteTlsRequested(configured)).toThrow(ConfigError);
    // The message has to be actionable on its own — it is the whole benefit
    // of failing over guessing.
    expect(() => isRemoteTlsRequested(configured)).toThrow(/actor-ts\.remote\.tls\.enabled/);
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
