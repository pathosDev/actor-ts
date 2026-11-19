import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import { ClusterClientOptions } from '../../../src/cluster/ClusterClientOptions.js';
import type { TlsTransportOptionsType } from '../../../src/runtime/tcp/TcpBackend.js';
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

describe('half a TLS client credential is refused (#1085)', () => {
  // Stand-ins: the rule looks at whether a field carries material, never at it.
  const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nstand-in\n-----END CERTIFICATE-----\n';
  const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nstand-in-secret\n-----END PRIVATE KEY-----\n';
  const AUTHORITY = '-----BEGIN CERTIFICATE-----\nstand-in-ca\n-----END CERTIFICATE-----\n';

  function refusalOf(tls: TlsTransportOptionsType): unknown {
    const options = ClusterClientOptions.create()
      .withContactPoints(['sys@127.0.0.1:2551'])
      .withTls(tls);
    try {
      new ClusterClient(options, noConfig());
      return undefined;
    } catch (error) {
      return error;
    }
  }

  test('a cert without a key is refused, naming both fields', () => {
    const refusal = refusalOf({ cert: CERTIFICATE, ca: AUTHORITY });
    expect(refusal).toBeInstanceOf(OptionsError);
    expect((refusal as OptionsError).field).toBe('tls');
    expect((refusal as Error).message).toContain('sets `cert` without `key`');
  });

  test('a key without a cert is refused, and the message carries no key material', () => {
    const refusal = refusalOf({ key: PRIVATE_KEY, ca: AUTHORITY });
    expect(refusal).toBeInstanceOf(OptionsError);
    expect((refusal as Error).message).toContain('sets `key` without `cert`');
    expect((refusal as Error).message).not.toContain('stand-in-secret');
    expect((refusal as OptionsError).value).toBeUndefined();
  });

  test('an empty half counts as absent', () => {
    expect(refusalOf({ cert: CERTIFICATE, key: '' })).toBeInstanceOf(OptionsError);
    expect(refusalOf({ cert: new Uint8Array(0), key: PRIVATE_KEY })).toBeInstanceOf(OptionsError);
  });

  test('one-way TLS (ca alone) and a whole credential are accepted', () => {
    expect(refusalOf({ ca: AUTHORITY })).toBeUndefined();
    expect(refusalOf({ cert: CERTIFICATE, key: PRIVATE_KEY, ca: AUTHORITY })).toBeUndefined();
    expect(refusalOf({ cert: '', key: '', ca: AUTHORITY })).toBeUndefined();
  });
});
