import { describe, expect, test } from 'bun:test';
import {
  FailureDetector,
  defaultFailureDetectorOptions,
} from '../../src/cluster/FailureDetector.js';
import { FailureDetectorOptions, type FailureDetectorOptionsType } from '../../src/cluster/FailureDetectorOptions.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';

const peer = new NodeAddress('demo', 'h', 1);
const other = new NodeAddress('demo', 'h', 2);

function fd(overrides: Partial<FailureDetectorOptionsType> = {}): FailureDetector {
  const fdOptions = FailureDetectorOptions.create()
    .withHeartbeatIntervalMs(overrides.heartbeatIntervalMs ?? 100)
    .withUnreachableAfterMs(overrides.unreachableAfterMs ?? 500)
    .withDownAfterMs(overrides.downAfterMs ?? 1_000);
  return new FailureDetector(
    fdOptions,
  );
}

describe('FailureDetector', () => {
  test('defaults are reasonable', () => {
    expect(defaultFailureDetectorOptions.heartbeatIntervalMs).toBeGreaterThan(0);
    expect(defaultFailureDetectorOptions.unreachableAfterMs)
      .toBeGreaterThan(defaultFailureDetectorOptions.heartbeatIntervalMs);
    expect(defaultFailureDetectorOptions.downAfterMs)
      .toBeGreaterThan(defaultFailureDetectorOptions.unreachableAfterMs);
  });

  test('unknown peer is considered healthy', () => {
    expect(fd().decide(peer)).toBe('healthy');
  });

  test('transitions healthy → unreachable → down as time passes', () => {
    const det = fd();
    const t0 = 10_000;
    det.heartbeat(peer, t0);

    // Inside the healthy window.
    expect(det.decide(peer, t0 + 100)).toBe('healthy');
    expect(det.decide(peer, t0 + 499)).toBe('healthy');

    // Just past unreachable threshold.
    expect(det.decide(peer, t0 + 500)).toBe('unreachable');
    expect(det.decide(peer, t0 + 999)).toBe('unreachable');

    // Past down threshold.
    expect(det.decide(peer, t0 + 1_000)).toBe('down');
    expect(det.decide(peer, t0 + 10_000)).toBe('down');
  });

  test('fresh heartbeat resets the peer back to healthy', () => {
    const det = fd();
    det.heartbeat(peer, 0);
    expect(det.decide(peer, 600)).toBe('unreachable');
    det.heartbeat(peer, 700);
    expect(det.decide(peer, 750)).toBe('healthy');
  });

  test('heardFrom refreshes last-seen exactly like heartbeat', () => {
    // The simple detector has no history to keep apart from liveness, so a
    // frame of any kind and a heartbeat frame are the same refresh.
    const viaHeartbeat = fd();
    const viaHeardFrom = fd();
    viaHeartbeat.heartbeat(peer, 1_000);
    viaHeardFrom.heardFrom(peer, 1_000);

    expect(viaHeardFrom.lastSeen(peer).getOrElse(-1)).toBe(1_000);
    expect(viaHeardFrom.lastSeen(peer).getOrElse(-1)).toBe(viaHeartbeat.lastSeen(peer).getOrElse(-1));
    for (const now of [1_000, 1_499, 1_500, 1_999, 2_000, 5_000]) {
      expect(viaHeardFrom.decide(peer, now)).toBe(viaHeartbeat.decide(peer, now));
    }

    // A refresh, not a register: it moves the last-seen of a peer it already knows.
    viaHeardFrom.heardFrom(peer, 1_700);
    expect(viaHeardFrom.lastSeen(peer).getOrElse(-1)).toBe(1_700);
    expect(viaHeardFrom.decide(peer, 2_100)).toBe('healthy');
  });

  test('register without heartbeat counts the peer as never-seen but tracked', () => {
    const det = fd();
    det.register(peer, 0);
    expect(det.lastSeen(peer).getOrElse(-1)).toBe(0);
    // Enough time passes → unreachable just like a normal peer.
    expect(det.decide(peer, 600)).toBe('unreachable');
  });

  test('at the shipped thresholds a registered peer never heard from is unreachable at 2 s and down at 5 s', () => {
    // The yardstick the φ-accrual detector's registered-but-silent case is
    // compared with: the simple detector has always judged from registration.
    const det = new FailureDetector();
    det.register(peer, 10_000);
    expect(det.decide(peer, 11_999)).toBe('healthy');
    expect(det.decide(peer, 12_000)).toBe('unreachable');
    expect(det.decide(peer, 14_999)).toBe('unreachable');
    expect(det.decide(peer, 15_000)).toBe('down');
  });

  test('register is a no-op if we already know the peer (does not reset lastSeen)', () => {
    const det = fd();
    det.heartbeat(peer, 100);
    det.register(peer, 999); // must NOT overwrite
    expect(det.lastSeen(peer).getOrElse(-1)).toBe(100);
  });

  test('forget erases the peer — decide returns healthy again', () => {
    const det = fd();
    det.heartbeat(peer, 0);
    expect(det.decide(peer, 1_500)).toBe('down');
    det.forget(peer);
    expect(det.decide(peer, 1_500)).toBe('healthy');
    expect(det.lastSeen(peer).isNone()).toBe(true);
  });

  test('peers are tracked independently', () => {
    const det = fd();
    det.heartbeat(peer, 0);
    det.heartbeat(other, 900);
    expect(det.decide(peer, 950)).toBe('unreachable');
    expect(det.decide(other, 950)).toBe('healthy');
  });

  test('interval getter reflects options', () => {
    expect(fd({ heartbeatIntervalMs: 250 }).interval).toBe(250);
  });

  test('lastSeen returns None for unknown peer', () => {
    expect(fd().lastSeen(peer).isNone()).toBe(true);
  });
});
