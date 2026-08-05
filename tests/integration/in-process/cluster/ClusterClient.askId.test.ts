/**
 * Regression for #120 — ClusterClient.ask() ID predictability.
 *
 * Pre-fix `nextAskId` returned `c${Date.now()}-${counter}` — an
 * attacker on the wire could pre-compute likely IDs and inject a
 * forged `cluster-client-reply` frame before the legitimate one,
 * resolving the caller's promise with attacker-chosen payload.
 *
 * Fix uses `crypto.randomUUID()` (122 bits of entropy per call).
 * These tests pin the format and uniqueness contract so a future
 * "let's optimise by hashing the counter again" regression fails
 * loudly.
 */
import { describe, expect, test } from 'bun:test';
import {
  _nextAskIdForTest,
  _syntheticClientPortForTest,
} from '../../../../src/cluster/ClusterClient.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('ClusterClient.nextAskId — #120 unpredictability', () => {
  test('returns a v4 UUID', () => {
    const id = _nextAskIdForTest();
    expect(id).toMatch(UUID_V4_RE);
  });

  test('no collisions across 10_000 calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(_nextAskIdForTest());
    expect(seen.size).toBe(10_000);
  });

  test('does not use the legacy "c<timestamp>-<counter>" shape', () => {
    // Legacy format: "c1747358291234-5".  New format is a v4 UUID,
    // covered by the format check above — this is a redundancy guard
    // for anyone who would "optimise" by stripping the dashes.
    for (let i = 0; i < 50; i++) {
      const id = _nextAskIdForTest();
      // No "c<digits>-<digits>" prefix.
      expect(/^c\d+-\d+$/.test(id)).toBe(false);
    }
  });
});

/**
 * The same class of finding, on the other identifier this file's subject
 * puts on the wire.  A client without an explicit `clientIdentity` names
 * itself by a synthetic port, and that port goes into the `NodeAddress` it
 * announces — so a peer able to predict it can address, impersonate or
 * pre-claim the client's slot in the cluster's `byPeer` map.
 *
 * It was `50_000 + Math.floor(Math.random() * 15_000)`, under a comment
 * claiming hrtime-derived randomness that the code did not do.
 */
describe('ClusterClient synthetic identity port', () => {
  test('stays inside the IANA ephemeral range', () => {
    for (let i = 0; i < 500; i++) {
      const port = _syntheticClientPortForTest();
      expect(port).toBeGreaterThanOrEqual(49_152);
      expect(port).toBeLessThanOrEqual(65_535);
      expect(Number.isInteger(port)).toBe(true);
    }
  });

  test('spreads across the range rather than a 15 000-slot window', () => {
    // The old draw could never exceed 64 999, so a run that never lands
    // above it is the regression.  Across 500 draws over 16 384 values the
    // chance of that happening by luck is about (536/16384)^500.
    const drawn = new Set<number>();
    for (let i = 0; i < 500; i++) drawn.add(_syntheticClientPortForTest());
    expect(Math.max(...drawn)).toBeGreaterThan(64_999);
    // And it is a draw, not a constant: distinct clients must not collide.
    expect(drawn.size).toBeGreaterThan(400);
  });
});
