import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import { ClusterClientOptions } from '../../../src/cluster/ClusterClientOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

// The ClusterClient constructor validates options before any network setup,
// so these assertions exercise the validator without spinning up a cluster.
//
// Every case passes an explicit empty Config (#858).  The constructor layers
// `actor-ts.cluster.client` under the caller's options and loads that config
// itself when none is given — it holds no ActorSystem, so there is nothing
// else to read it from — which would make these four cases depend on whatever
// `application.conf` happens to sit in the working directory and on whether
// ACTOR_TS_CONFIG is set.  What the block *does* supply is asserted in
// tests/unit/config/ClusterClientConfigDefaults.test.ts, deliberately from a
// Config the test built.
const noConfig = (): Config => Config.empty();

describe('ClusterClientOptions validation', () => {
  test('rejects empty contactPoints', () => {
    const options = ClusterClientOptions.create().withContactPoints([]);
    expect(() => new ClusterClient(options, noConfig())).toThrow(OptionsError);
    expect(() => new ClusterClient(options, noConfig()))
      .toThrow(/contactPoints must contain at least one entry/);
  });

  test('rejects missing contactPoints (plain object)', () => {
    expect(() => new ClusterClient({}, noConfig())).toThrow(OptionsError);
  });

  test('rejects a non-positive askTimeoutMs', () => {
    const options = ClusterClientOptions.create()
      .withContactPoints(['sys@127.0.0.1:2551'])
      .withAskTimeoutMs(0);
    expect(() => new ClusterClient(options, noConfig())).toThrow(OptionsError);
  });

  test('rejects a non-positive connectTimeoutMs', () => {
    const options = ClusterClientOptions.create()
      .withContactPoints(['sys@127.0.0.1:2551'])
      .withConnectTimeoutMs(0);
    expect(() => new ClusterClient(options, noConfig())).toThrow(OptionsError);
  });

  test('accepts a valid configuration', () => {
    const options = ClusterClientOptions.create()
      .withContactPoints(['sys@127.0.0.1:2551'])
      .withAskTimeoutMs(3_000)
      .withConnectTimeoutMs(1_500);
    expect(() => new ClusterClient(options, noConfig())).not.toThrow();
  });
});
