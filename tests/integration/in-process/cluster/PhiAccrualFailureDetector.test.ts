import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { PhiAccrualFailureDetector, PhiAccrualOptions } from '../../../../src/cluster/PhiAccrualFailureDetector.js';

const addr = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);

describe('PhiAccrualFailureDetector', () => {
  test('settings validation rejects bad thresholds', () => {
    expect(() => new PhiAccrualFailureDetector(PhiAccrualOptions.create().withUnreachableThreshold(8).withDownThreshold(8)))
      .toThrow(/downThreshold must exceed/);
    expect(() => new PhiAccrualFailureDetector(PhiAccrualOptions.create().withMaxSampleSize(0)))
      .toThrow(/maxSampleSize/);
  });

  test('unknown peer is healthy', () => {
    const fd = new PhiAccrualFailureDetector();
    expect(fd.decide(addr(1))).toBe('healthy');
  });

  test('steady heartbeats keep phi near zero', () => {
    const fd = new PhiAccrualFailureDetector(PhiAccrualOptions.create().withHeartbeatIntervalMs(100));
    const p = addr(2);
    fd.register(p, 0);
    for (let i = 1; i <= 50; i++) fd.heartbeat(p, i * 100);
    // "Now" equals the last heartbeat timestamp — no elapsed time, phi ~ 0.
    expect(fd.phi(p, 50 * 100)).toBeLessThan(1);
    expect(fd.decide(p, 50 * 100)).toBe('healthy');
  });

  test('silence accumulates phi, eventually crossing thresholds', () => {
    const fd = new PhiAccrualFailureDetector(
      PhiAccrualOptions.create()
        .withHeartbeatIntervalMs(100)
        .withMinStdDeviationMs(10)
        .withUnreachableThreshold(5)
        .withDownThreshold(12)
        .withAcceptableHeartbeatPauseMs(0),
    );
    const p = addr(3);
    fd.register(p, 0);
    const last = 50 * 100;
    for (let i = 1; i <= 50; i++) fd.heartbeat(p, i * 100);

    // Right after the last heartbeat: healthy.
    expect(fd.decide(p, last)).toBe('healthy');

    // Phi grows monotonically with elapsed time.
    const phiEarly = fd.phi(p, last + 100);
    const phiLater = fd.phi(p, last + 1_000);
    expect(phiLater).toBeGreaterThan(phiEarly);

    // Long silence should cross both thresholds.
    expect(fd.decide(p, last + 5_000)).toBe('down');
  });

  test('acceptableHeartbeatPauseMs gives leeway before phi rises', () => {
    const lenient = new PhiAccrualFailureDetector(
      PhiAccrualOptions.create()
        .withHeartbeatIntervalMs(100)
        .withMinStdDeviationMs(10)
        .withAcceptableHeartbeatPauseMs(500)
        .withUnreachableThreshold(5),
    );
    const p = addr(4);
    lenient.register(p, 0);
    for (let i = 1; i <= 50; i++) lenient.heartbeat(p, i * 100);
    const last = 50 * 100;

    // 300ms after last heartbeat is still within the grace window.
    expect(lenient.phi(p, last + 300)).toBeLessThan(0.5);
  });

  test('forget removes all state', () => {
    const fd = new PhiAccrualFailureDetector();
    const p = addr(5);
    fd.heartbeat(p, 0);
    fd.forget(p);
    expect(fd.lastSeen(p).isNone()).toBe(true);
    expect(fd.decide(p)).toBe('healthy');
  });
});
