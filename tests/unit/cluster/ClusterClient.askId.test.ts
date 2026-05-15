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
import { _nextAskIdForTest } from '../../../src/cluster/ClusterClient.js';

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
