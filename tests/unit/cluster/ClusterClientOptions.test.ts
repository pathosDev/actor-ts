import { describe, expect, test } from 'bun:test';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import { ClusterClientOptions } from '../../../src/cluster/ClusterClientOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

// The ClusterClient constructor validates options before any network setup,
// so these assertions exercise the validator without spinning up a cluster.
describe('ClusterClientOptions validation', () => {
  test('rejects empty contactPoints', () => {
    const opts = ClusterClientOptions.create().withContactPoints([]);
    expect(() => new ClusterClient(opts)).toThrow(OptionsError);
    expect(() => new ClusterClient(opts)).toThrow(/contactPoints must contain at least one entry/);
  });

  test('rejects missing contactPoints (plain object)', () => {
    expect(() => new ClusterClient({})).toThrow(OptionsError);
  });

  test('rejects a non-positive askTimeoutMs', () => {
    const opts = ClusterClientOptions.create()
      .withContactPoints(['sys@127.0.0.1:2551'])
      .withAskTimeoutMs(0);
    expect(() => new ClusterClient(opts)).toThrow(OptionsError);
  });

  test('accepts a valid configuration', () => {
    const opts = ClusterClientOptions.create()
      .withContactPoints(['sys@127.0.0.1:2551'])
      .withAskTimeoutMs(3_000);
    expect(() => new ClusterClient(opts)).not.toThrow();
  });
});
