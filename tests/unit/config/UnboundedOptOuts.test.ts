import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import type { ActorSystem } from '../../../src/ActorSystem.js';
import { resolveWebsocketPolicy } from '../../../src/http/websocket/WebsocketPolicy.js';
import { readObjectStoragePluginOptionsFromConfig } from '../../../src/persistence/object-storage/ObjectStoragePluginOptions.js';

/**
 * `reference.conf` documents exactly two keys whose "off" switch is spelled
 * `+Infinity`, and says of both that it is *code only* because HOCON has no
 * `Infinity` literal.  #1513 then gave the numeric accessors a blanket
 * finiteness check, which narrowed that contract to the fluent builders alone
 * — the JSDoc it shipped with claimed the two keys "do not pass through here",
 * and they do, on the accessor each is read with:
 *
 *   - `WebsocketPolicy.readWebsocketPolicyOptionsFromConfig`, called by
 *     `resolveWebsocketPolicy` → `getDuration(accept-timeout)`
 *   - `ObjectStoragePluginOptions.readObjectStoragePluginOptionsFromConfig`
 *     → `getBytes(max-decompressed-bytes)`
 *
 * Both consumers are built for the value: `ConnectionWiring` arms the accept
 * watchdog behind `Number.isFinite(policy.acceptTimeoutMs)`, and the two
 * validators admit `Infinity` by name (`positiveIntOrUnbounded`,
 * `maxDecompressedBytesRule`).  So the accessor was the one layer that
 * disagreed with the contract the other three state.
 *
 * These tests read through the **real** readers rather than only the accessor,
 * because the accessor-level assertion alone would keep passing if a reader
 * stopped consulting config at all — which is also the ceiling `NoDeadConfigKeys`
 * has, and the reason the exception list living in `Config.ts` does not weaken
 * anything that was actually checking these two keys.
 */

/** Minimal ActorSystem stand-in — resolveWebsocketPolicy only reads `.config`. */
function systemWith(overrides: object): ActorSystem {
  return { config: Config.fromObject(overrides) } as unknown as ActorSystem;
}

function websocketConfig(value: unknown): object {
  return { 'actor-ts': { http: { websocket: { 'accept-timeout': value } } } };
}

function objectStorageConfig(value: unknown): object {
  return {
    'actor-ts': {
      persistence: { 'snapshot-store': { 'object-storage': { 'max-decompressed-bytes': value } } },
    },
  };
}

describe('the documented Infinity opt-outs survive a code-supplied config (#1513)', () => {
  test('an Infinity accept-timeout reaches the resolved policy and disarms the watchdog gate', () => {
    const system = systemWith(websocketConfig(Number.POSITIVE_INFINITY));
    const policy = resolveWebsocketPolicy(system, {});
    expect(policy.acceptTimeoutMs).toBe(Number.POSITIVE_INFINITY);
    // The gate `ConnectionWiring` actually uses, asserted on the value the
    // resolver produced rather than on a literal — an opt-out that arrives as
    // anything finite would arm a watchdog the operator switched off.
    expect(Number.isFinite(policy.acceptTimeoutMs)).toBe(false);
  });

  test('an Infinity max-decompressed-bytes reaches the plugin options', () => {
    const options = readObjectStoragePluginOptionsFromConfig(
      Config.fromObject(objectStorageConfig(Number.POSITIVE_INFINITY)),
    );
    expect(options.maxDecompressedBytes).toBe(Number.POSITIVE_INFINITY);
  });

  test('a finite value at either key is still read exactly as written', () => {
    // The opt-out must not become "this key is unchecked": a real bound still
    // has to arrive unrounded and unreplaced.
    const system = systemWith(websocketConfig('30s'));
    expect(resolveWebsocketPolicy(system, {}).acceptTimeoutMs).toBe(30_000);
    expect(resolveWebsocketPolicy(systemWith(websocketConfig(250)), {}).acceptTimeoutMs).toBe(250);
    const options = readObjectStoragePluginOptionsFromConfig(
      Config.fromObject(objectStorageConfig('512M')),
    );
    expect(options.maxDecompressedBytes).toBe(536_870_912);
  });
});

describe('the opt-out is positive-only, key-exact and accessor-exact (#1513)', () => {
  test('NaN and -Infinity stay refused at both opt-out keys', () => {
    // Neither spells anything at either key: the validators reject both, and
    // `Number.isFinite` reads `NaN` as "arm the watchdog" with a `NaN` delay.
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        Config.fromObject(websocketConfig(bad)).getDuration(ConfigKeys.http.websocket.acceptTimeout),
      ).toThrow(ConfigError);
      expect(() =>
        Config.fromObject(objectStorageConfig(bad)).getBytes(
          ConfigKeys.persistence.snapshotStore.objectStorage.maxDecompressedBytes,
        ),
      ).toThrow(/is not a finite size/);
    }
  });

  test('a neighbouring key in the same block still refuses Infinity', () => {
    // `max-frame-bytes` sits one leaf away from `accept-timeout` and has no
    // unbounded spelling at all — an exception keyed on the block rather than
    // the leaf would take the cap off a frame guard.
    const websocket = Config.fromObject({
      'actor-ts': { http: { websocket: { 'max-frame-bytes': Number.POSITIVE_INFINITY } } },
    });
    expect(() => websocket.getBytes(ConfigKeys.http.websocket.maxFrameBytes)).toThrow(
      /is not a finite size \(got Infinity\)/,
    );
    const keepN = Config.fromObject({
      'actor-ts': {
        persistence: { 'snapshot-store': { 'object-storage': { 'keep-n': Number.POSITIVE_INFINITY } } },
      },
    });
    expect(() =>
      keepN.getNumber(ConfigKeys.persistence.snapshotStore.objectStorage.keepN),
    ).toThrow(/is not a finite number \(got Infinity\)/);
  });

  test('an opt-out key read with a different accessor still refuses Infinity', () => {
    // The exception is granted to the reader that exists, not to the path in
    // the abstract: `accept-timeout` is a duration and nothing reads it as a
    // number or a size.
    const websocket = Config.fromObject(websocketConfig(Number.POSITIVE_INFINITY));
    expect(() => websocket.getNumber(ConfigKeys.http.websocket.acceptTimeout)).toThrow(
      /is not a finite number \(got Infinity\)/,
    );
    expect(() => websocket.getBytes(ConfigKeys.http.websocket.acceptTimeout)).toThrow(
      /is not a finite size \(got Infinity\)/,
    );
    const store = Config.fromObject(objectStorageConfig(Number.POSITIVE_INFINITY));
    expect(() =>
      store.getDuration(ConfigKeys.persistence.snapshotStore.objectStorage.maxDecompressedBytes),
    ).toThrow(/is not a finite duration \(got Infinity\)/);
  });

  test('a path that merely contains an opt-out path still refuses Infinity', () => {
    // Pins the match as an equality rather than a `startsWith` / `endsWith` /
    // `includes`, each of which would hand the opt-out to a key nobody granted
    // it — including one an application invented under its own root.
    const longer = Config.fromObject({
      'actor-ts': { http: { websocket: { 'accept-timeout-grace': Number.POSITIVE_INFINITY } } },
    });
    expect(() => longer.getDuration('actor-ts.http.websocket.accept-timeout-grace')).toThrow(
      /is not a finite duration \(got Infinity\)/,
    );
    const nested = Config.fromObject({ app: websocketConfig(Number.POSITIVE_INFINITY) });
    expect(() => nested.getDuration('app.actor-ts.http.websocket.accept-timeout')).toThrow(
      /is not a finite duration \(got Infinity\)/,
    );
    const prefix = Config.fromObject({ 'actor-ts': { http: { websocket: 1 } } });
    expect(() => prefix.getDuration('actor-ts.http.websocket')).not.toThrow();
  });

  test('a string that spells infinity is still refused at the opt-out keys', () => {
    // HOCON text cannot carry the opt-out, and must not start to: the exception
    // lives on the numeric branch, so these keep failing in `parseDuration` with
    // the message #785 gave it rather than being waved through by path.
    for (const spelling of ['Infinity', 'infinity', '1e999', '9'.repeat(400)]) {
      expect(() =>
        Config.parseString(`actor-ts.http.websocket.accept-timeout = "${spelling}"`)
          .getDuration(ConfigKeys.http.websocket.acceptTimeout),
      ).toThrow(/Invalid duration|Unknown duration unit/);
    }
    expect(() =>
      Config.parseString(
        `actor-ts.persistence.snapshot-store.object-storage.max-decompressed-bytes = "Infinity"`,
      ).getBytes(ConfigKeys.persistence.snapshotStore.objectStorage.maxDecompressedBytes),
    ).toThrow(/Invalid size|Unknown size unit/);
  });
});
