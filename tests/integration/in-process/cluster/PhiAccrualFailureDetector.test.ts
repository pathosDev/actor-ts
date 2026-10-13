import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { PhiAccrualFailureDetector } from '../../../../src/cluster/PhiAccrualFailureDetector.js';
import { PhiAccrualOptions } from '../../../../src/cluster/PhiAccrualOptions.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const addr = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);

describe('PhiAccrualFailureDetector', () => {
  test('options validation rejects bad thresholds', () => {
    const badThresholdOptions = PhiAccrualOptions.create()
      .withUnreachableThreshold(8)
      .withDownThreshold(8);
    expect(() => new PhiAccrualFailureDetector(badThresholdOptions))
      .toThrow(OptionsError);
    expect(() => new PhiAccrualFailureDetector(badThresholdOptions))
      .toThrow(/downThreshold must exceed/);
    const badSampleSizeOptions = PhiAccrualOptions.create().withMaxSampleSize(0);
    expect(() => new PhiAccrualFailureDetector(badSampleSizeOptions))
      .toThrow(/maxSampleSize/);
  });

  test('unknown peer is healthy', () => {
    const fd = new PhiAccrualFailureDetector();
    expect(fd.decide(addr(1))).toBe('healthy');
  });

  test('steady heartbeats keep phi near zero', () => {
    const detectorOptions = PhiAccrualOptions.create().withHeartbeatIntervalMs(100);
    const fd = new PhiAccrualFailureDetector(detectorOptions);
    const peerAddress = addr(2);
    fd.register(peerAddress, 0);
    for (let i = 1; i <= 50; i++) fd.heartbeat(peerAddress, i * 100);
    // "Now" equals the last heartbeat timestamp — no elapsed time, phi ~ 0.
    expect(fd.phi(peerAddress, 50 * 100)).toBeLessThan(1);
    expect(fd.decide(peerAddress, 50 * 100)).toBe('healthy');
  });

  test('silence accumulates phi, eventually crossing thresholds', () => {
    const detectorOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(100)
      .withMinStdDeviationMs(10)
      .withUnreachableThreshold(5)
      .withDownThreshold(12)
      .withAcceptableHeartbeatPauseMs(0);
    const fd = new PhiAccrualFailureDetector(detectorOptions);
    const peerAddress = addr(3);
    fd.register(peerAddress, 0);
    const last = 50 * 100;
    for (let i = 1; i <= 50; i++) fd.heartbeat(peerAddress, i * 100);

    // Right after the last heartbeat: healthy.
    expect(fd.decide(peerAddress, last)).toBe('healthy');

    // Phi grows monotonically with elapsed time.
    const phiEarly = fd.phi(peerAddress, last + 100);
    const phiLater = fd.phi(peerAddress, last + 1_000);
    expect(phiLater).toBeGreaterThan(phiEarly);

    // Long silence should cross both thresholds.
    expect(fd.decide(peerAddress, last + 5_000)).toBe('down');
  });

  test('acceptableHeartbeatPauseMs gives leeway before phi rises', () => {
    const lenientOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(100)
      .withMinStdDeviationMs(10)
      .withAcceptableHeartbeatPauseMs(500)
      .withUnreachableThreshold(5);
    const lenient = new PhiAccrualFailureDetector(lenientOptions);
    const peerAddress = addr(4);
    lenient.register(peerAddress, 0);
    for (let i = 1; i <= 50; i++) lenient.heartbeat(peerAddress, i * 100);
    const last = 50 * 100;

    // 300ms after last heartbeat is still within the grace window.
    expect(lenient.phi(peerAddress, last + 300)).toBeLessThan(0.5);
  });

  test('heardFrom moves the silence origin and adds no sample', () => {
    // The same clean 500 ms series on two detectors, one of which also hears a
    // frame that is not a heartbeat 400 ms after the last beat.
    const detectorOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(500)
      .withAcceptableHeartbeatPauseMs(0);
    const heartbeatsOnly = new PhiAccrualFailureDetector(detectorOptions);
    const withTraffic = new PhiAccrualFailureDetector(detectorOptions);
    const peerAddress = addr(6);
    for (let beat = 0; beat <= 20; beat++) {
      heartbeatsOnly.heartbeat(peerAddress, beat * 500);
      withTraffic.heartbeat(peerAddress, beat * 500);
    }
    const lastBeat = 20 * 500;
    withTraffic.heardFrom(peerAddress, lastBeat + 400);

    // Liveness: silence is measured from the frame, so the detector that heard
    // it is exactly 400 ms behind the one that did not.
    expect(withTraffic.lastSeen(peerAddress).getOrElse(-1)).toBe(lastBeat + 400);
    for (const silence of [0, 500, 1_000, 1_500, 3_000]) {
      expect(withTraffic.phi(peerAddress, lastBeat + 400 + silence))
        .toBe(heartbeatsOnly.phi(peerAddress, lastBeat + silence));
    }

    // No sample: the next heartbeat is measured from the last heartbeat, not
    // from the frame, so the two histories are still the same one.
    heartbeatsOnly.heartbeat(peerAddress, lastBeat + 500);
    withTraffic.heartbeat(peerAddress, lastBeat + 500);
    for (const silence of [0, 600, 1_100, 2_000]) {
      expect(withTraffic.phi(peerAddress, lastBeat + 500 + silence))
        .toBe(heartbeatsOnly.phi(peerAddress, lastBeat + 500 + silence));
    }
  });

  test('forget removes all state', () => {
    const fd = new PhiAccrualFailureDetector();
    const peerAddress = addr(5);
    fd.heartbeat(peerAddress, 0);
    fd.forget(peerAddress);
    expect(fd.lastSeen(peerAddress).isNone()).toBe(true);
    expect(fd.decide(peerAddress)).toBe('healthy');
  });
});
