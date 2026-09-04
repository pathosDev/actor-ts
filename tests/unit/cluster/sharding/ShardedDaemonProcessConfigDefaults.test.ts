import { describe, expect, test } from 'bun:test';
import { Config } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import {
  DEFAULT_DAEMON_LIVENESS_INTERVAL_MS,
  readShardedDaemonProcessOptionsFromConfig,
} from '../../../../src/cluster/sharding/ShardedDaemonProcessOptions.js';
import type { ShardedDaemonProcessOptionsType } from '../../../../src/cluster/sharding/ShardedDaemonProcessOptions.js';
import { mergeOptions } from '../../../../src/util/OptionsMerge.js';

/**
 * `actor-ts.sharded-daemon-process.*` (#854).  `ShardedDaemonProcess.init` used
 * to cast its argument straight to the settings type, so a daemon set was
 * tunable from code and from nowhere else; these cover the reader and the
 * precedence the merge it now runs is supposed to have.
 *
 * `Config.parseString`, never `Config.fromObject({'actor-ts.x.y': …})` — the
 * latter keeps the dotted string as a literal top-level key, so `hasPath`
 * would resolve the *nested* reference.conf value underneath and the test
 * would assert nothing.
 */
describe('readShardedDaemonProcessOptionsFromConfig', () => {
  test('reads every key of the sharded-daemon-process block', () => {
    const config = Config.parseString(`
      actor-ts.sharded-daemon-process {
        liveness-interval = 45s
        role              = "daemons"
      }
    `);

    expect(readShardedDaemonProcessOptionsFromConfig(config)).toEqual({
      livenessIntervalMs: 45_000,
      role: 'daemons',
    });
  });

  test('omits absent keys entirely rather than reporting them as undefined', () => {
    const config = Config.parseString('actor-ts.sharded-daemon-process.liveness-interval = 90s');
    const fromConfig = readShardedDaemonProcessOptionsFromConfig(config);

    expect(fromConfig).toEqual({ livenessIntervalMs: 90_000 });
    // The distinction that matters: a present-but-undefined key would shadow
    // the built-in default once spread.
    expect(Object.keys(fromConfig)).toEqual(['livenessIntervalMs']);
  });

  test('an empty config yields no settings at all', () => {
    expect(readShardedDaemonProcessOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // The value `reference.conf` ships has to match what the code falls back
    // to, or merely wiring the block would change behaviour for everyone.
    //
    // `role` is absent from the result even though the leaf DOES ship: it
    // ships as `""`, so `hasPath` is true on every node forever, and the
    // reader's empty-string skip is the only thing keeping an explicit
    // `role: ''` out of every daemon set — see the next test for what that
    // would cost.
    const config = Config.loadReference();
    const fromConfig = readShardedDaemonProcessOptionsFromConfig(config);

    expect(fromConfig).toEqual({ livenessIntervalMs: DEFAULT_DAEMON_LIVENESS_INTERVAL_MS });
    expect(Object.keys(fromConfig)).toEqual(['livenessIntervalMs']);
  });

  test('an empty role is "no daemon-specific opinion", not a role named ""', () => {
    // The shape an operator hits by leaving the shipped line alone.  Returned,
    // `role: ''` would reach `ClusterSharding.start` as an EXPLICIT role and
    // `mergeOptions` — which falls through on `undefined` only — would let it
    // shadow `actor-ts.sharding.role` for the daemon region and nothing else.
    // Omitting the key is what makes the daemon region inherit the global role
    // like every other sharded type (#847).
    const config = Config.parseString('actor-ts.sharded-daemon-process.role = ""');

    expect(readShardedDaemonProcessOptionsFromConfig(config)).toEqual({});
    expect(Object.keys(readShardedDaemonProcessOptionsFromConfig(config))).toEqual([]);
  });

  test('a non-empty role IS returned', () => {
    const config = Config.parseString('actor-ts.sharded-daemon-process.role = "compute"');

    expect(readShardedDaemonProcessOptionsFromConfig(config)).toEqual({ role: 'compute' });
  });

  test('every key it reads is reachable from ConfigKeys', () => {
    expect(ConfigKeys.shardedDaemonProcess).toEqual({
      livenessInterval: 'actor-ts.sharded-daemon-process.liveness-interval',
      role: 'actor-ts.sharded-daemon-process.role',
    });
  });
});

/**
 * The precedence `ShardedDaemonProcess.init` gets from `mergeOptions`, spelled
 * out on the same three layers it passes: `{}`, the reader's output, then the
 * caller's options.
 */
describe('ShardedDaemonProcess settings precedence', () => {
  const resolve = (
    config: Config,
    explicit: Partial<ShardedDaemonProcessOptionsType<string>>,
  ): ShardedDaemonProcessOptionsType<string> =>
    mergeOptions<ShardedDaemonProcessOptionsType<string>>(
      {},
      readShardedDaemonProcessOptionsFromConfig(config) as Partial<ShardedDaemonProcessOptionsType<string>>,
      explicit,
    );

  const config = Config.parseString(`
    actor-ts.sharded-daemon-process {
      liveness-interval = 45s
      role              = "from-hocon"
    }
  `);

  test('explicit options beat HOCON', () => {
    const settings = resolve(config, { livenessIntervalMs: 5_000, role: 'from-code' });

    expect(settings.livenessIntervalMs).toBe(5_000);
    expect(settings.role).toBe('from-code');
  });

  test('HOCON fills in what the caller left unset', () => {
    const settings = resolve(config, {});

    expect(settings.livenessIntervalMs).toBe(45_000);
    expect(settings.role).toBe('from-hocon');
  });

  test('an explicit undefined falls through to HOCON rather than clearing it', () => {
    // The shape a spread of a partial produces.  `mergeOptions` treats
    // `undefined` as "not set", never as "explicitly clear".
    const settings = resolve(config, { livenessIntervalMs: undefined, role: undefined });

    expect(settings.livenessIntervalMs).toBe(45_000);
    expect(settings.role).toBe('from-hocon');
  });

  test('an explicit 0 liveness interval shadows HOCON — it disables the ping', () => {
    // `0` is a real value, not "unset": it is how a caller switches the
    // heartbeat off.  Reading it as absent would silently re-arm a timer the
    // caller asked not to have.
    const settings = resolve(config, { livenessIntervalMs: 0 });

    expect(settings.livenessIntervalMs).toBe(0);
  });
});
