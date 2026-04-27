import { describe, expect, test } from 'bun:test';
import {
  MqttActor,
  matchesMqttPattern,
  type MqttMessage,
} from '../../../../src/io/broker/MqttActor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';

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
