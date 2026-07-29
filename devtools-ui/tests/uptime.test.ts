import { describe, expect, test } from 'bun:test';
import { uptimeMillis } from '../src/panels/dashboard/uptime.js';
import type { WelcomeFrame } from '../../src/devtools/protocol/index.js';

const MINUTE_MS = 60_000;

/** Only the two fields the uptime maths reads. */
function welcome(startedAtMs: number): WelcomeFrame {
  return { startedAtMs, systemName: 'orders' } as WelcomeFrame;
}

describe('uptimeMillis', () => {
  test('advances with the local clock between samples', () => {
    const anchor = { uptimeMs: 10 * MINUTE_MS, receivedAtMs: 1_000_000 };
    expect(uptimeMillis(anchor, null, 1_000_000)).toBe(10 * MINUTE_MS);
    expect(uptimeMillis(anchor, null, 1_000_000 + 2_500)).toBe(10 * MINUTE_MS + 2_500);
  });

  test('stands still while nothing answers', () => {
    const anchor = { uptimeMs: 10 * MINUTE_MS, receivedAtMs: 1_000_000 };
    // What the panel passes once the connection dropped: the moment it
    // dropped, not the wall clock.  Reading it again a minute later must
    // give the same answer — a counter that kept climbing would be
    // claiming a system is alive that has not answered in a minute.
    const droppedAtMs = 1_030_000;
    expect(uptimeMillis(anchor, null, droppedAtMs)).toBe(10 * MINUTE_MS + 30_000);
    expect(uptimeMillis(anchor, null, droppedAtMs)).toBe(10 * MINUTE_MS + 30_000);
  });

  test('falls back to the handshake before the first sample', () => {
    expect(uptimeMillis(null, welcome(1_000_000), 1_000_000 + MINUTE_MS)).toBe(MINUTE_MS);
  });

  test('has nothing to show before the handshake', () => {
    expect(uptimeMillis(null, null, 1_000_000)).toBeNull();
  });
});
