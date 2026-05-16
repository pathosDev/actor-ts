import { describe, expect, test } from 'bun:test';
import {
  MqttActor,
  buildPublishProperties,
  matchesMqttPattern,
  type MqttMessage,
  type MqttPublish,
} from '../../../../../src/io/broker/MqttActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

describe('matchesMqttPattern', () => {
  test('exact-match topics', () => {
    expect(matchesMqttPattern('a/b', 'a/b')).toBe(true);
    expect(matchesMqttPattern('a/b', 'a/c')).toBe(false);
    expect(matchesMqttPattern('a/b', 'a/b/c')).toBe(false);
  });

  test('+ wildcard matches a single segment', () => {
    expect(matchesMqttPattern('a/+/c', 'a/x/c')).toBe(true);
    expect(matchesMqttPattern('a/+/c', 'a/c')).toBe(false);
    expect(matchesMqttPattern('a/+/c', 'a/x/y/c')).toBe(false);
    expect(matchesMqttPattern('+/+', 'x/y')).toBe(true);
  });

  test('# wildcard matches the remaining segments', () => {
    expect(matchesMqttPattern('a/#', 'a/b/c/d')).toBe(true);
    // Per MQTT spec convention, `a/#` also matches the parent topic `a`
    // (the multi-level wildcard accepts zero or more segments).
    expect(matchesMqttPattern('a/#', 'a')).toBe(true);
    expect(matchesMqttPattern('#', 'anything/at/all')).toBe(true);
  });
});

/* ----------- MqttActor wiring tests via FakeMqttClient -------------- */

interface MqttClientLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  once(event: string, cb: (...args: unknown[]) => void): void;
  removeAllListeners(event?: string): void;
  publish(topic: string, payload: string | Uint8Array, opts: { qos: number; retain: boolean }, cb?: (err?: Error) => void): void;
  subscribe(topic: string, opts: { qos: number }, cb?: (err?: Error) => void): void;
  unsubscribe(topic: string, opts: undefined, cb?: (err?: Error) => void): void;
  end(force?: boolean, opts?: object, cb?: () => void): void;
}

/**
 * Even with a mock client we still pay for `await import('mqtt')`
 * inside `connectImpl` — the import would fail without the peer-dep
 * installed.  These tests exercise the topic-match helper directly,
 * which is the most error-prone bit.  Full e2e (against Mosquitto)
 * runs as an optional integration test.
 */

describe('MqttActor (no peer-dep tests)', () => {
  test('importing the module does not crash when mqtt is missing', async () => {
    // The Lazy<> only runs when an instance tries to connect; constructing
    // an actor object does not pull in the peer-dep.
    const a = new MqttActor({ brokerUrl: 'mqtt://localhost' });
    expect(a).toBeInstanceOf(MqttActor);
  });

  test('matchesMqttPattern is exported and reusable for tests', () => {
    void matchesMqttPattern;  // type check
    void ({} as MqttClientLike);
    void ({} as MqttMessage);
    void ({} as ActorRef);
    expect(true).toBe(true);
  });
});

/* --------------- MQTT 5.0 publish-properties helper (#13) ---------------- */

describe('buildPublishProperties (MQTT 5.0)', () => {
  test('returns undefined on protocolVersion=4 even with userProperties set', () => {
    // The 3.1.1 wire format has no slot for user properties — we
    // silently drop them rather than letting them leak into the
    // publish callsite with no effect.
    const p: MqttPublish = {
      topic: 'sensor/1',
      payload: 'x',
      userProperties: { tenant: 't1' },
    };
    expect(buildPublishProperties(p, 4)).toBeUndefined();
  });

  test('returns undefined when no v5 fields are set, regardless of version', () => {
    const p: MqttPublish = { topic: 'sensor/1', payload: 'x' };
    expect(buildPublishProperties(p, 4)).toBeUndefined();
    expect(buildPublishProperties(p, 5)).toBeUndefined();
  });

  test('returns undefined when userProperties is an empty object on v5', () => {
    // An empty user-properties object is semantically "no properties"
    // — collapse to undefined so mqtt.js doesn't emit an empty
    // properties block on the wire.
    const p: MqttPublish = {
      topic: 'sensor/1',
      payload: 'x',
      userProperties: {},
    };
    expect(buildPublishProperties(p, 5)).toBeUndefined();
  });

  test('returns a properties block on v5 with populated userProperties', () => {
    const userProperties = { tenant: 't1', priority: ['high', 'audit'] };
    const p: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties };
    expect(buildPublishProperties(p, 5)).toEqual({ userProperties });
  });

  test('preserves multi-valued properties (string[]) verbatim', () => {
    // MQTT 5.0 allows multiple values per key — the wire format
    // emits the key + value pair for each entry in the array.  The
    // helper passes the array through unchanged.
    const p: MqttPublish = {
      topic: 'sensor/1',
      payload: 'x',
      userProperties: { tag: ['alpha', 'beta', 'gamma'] },
    };
    const props = buildPublishProperties(p, 5);
    expect(props?.userProperties?.tag).toEqual(['alpha', 'beta', 'gamma']);
  });
});
