import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { defaultPhiAccrualOptions, PhiAccrualFailureDetector } from '../../../../src/cluster/PhiAccrualFailureDetector.js';
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

type Crossings = { readonly unreachable: number; readonly down: number };

/**
 * Silence, measured from `origin`, until `decide` first leaves `healthy` and
 * until it first says `down`.  A binary search, because φ only rises while
 * nothing arrives — and an explicit `now` throughout, so the numbers are the
 * detector's arithmetic and nothing else.
 */
function crossingsAfter(fd: PhiAccrualFailureDetector, peer: NodeAddress, origin: number): Crossings {
  const first = (holds: (now: number) => boolean): number => {
    let low = origin;
    let high = origin + 120_000;
    if (!holds(high)) return Number.POSITIVE_INFINITY;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (holds(middle)) high = middle; else low = middle + 1;
    }
    return low - origin;
  };
  return {
    unreachable: first((now) => fd.decide(peer, now) !== 'healthy'),
    down: first((now) => fd.decide(peer, now) === 'down'),
  };
}

/** Within 10 ms: the normal-tail approximation behind φ is good to a few milliseconds here, not to one. */
function expectCrossings(actual: Crossings, unreachable: number, down: number): void {
  expect(actual.unreachable).toBeGreaterThanOrEqual(unreachable - 10);
  expect(actual.unreachable).toBeLessThanOrEqual(unreachable + 10);
  expect(actual.down).toBeGreaterThanOrEqual(down - 10);
  expect(actual.down).toBeLessThanOrEqual(down + 10);
}

describe('expected-response-after: what φ assumes before it has a history (#1451)', () => {
  test('takes a positive duration or the word auto, and nothing else', () => {
    for (const refused of [0, -500, Number.NaN, Number.POSITIVE_INFINITY]) {
      const refusedOptions = PhiAccrualOptions.create().withExpectedResponseAfterMs(refused);
      expect(() => new PhiAccrualFailureDetector(refusedOptions)).toThrow(OptionsError);
      expect(() => new PhiAccrualFailureDetector(refusedOptions)).toThrow(/expectedResponseAfterMs/);
    }
    // A word other than auto has a way in that the type does not show: a
    // config file, read as a string first.
    const otherWord = { expectedResponseAfterMs: 'never' as unknown as 'auto' };
    expect(() => new PhiAccrualFailureDetector(otherWord)).toThrow(OptionsError);
    expect(() => new PhiAccrualFailureDetector(otherWord)).toThrow(/expectedResponseAfterMs/);

    const autoOptions = PhiAccrualOptions.create().withExpectedResponseAfterMs('auto');
    const durationOptions = PhiAccrualOptions.create().withExpectedResponseAfterMs(1_500);
    expect(() => new PhiAccrualFailureDetector(autoOptions)).not.toThrow();
    expect(() => new PhiAccrualFailureDetector(durationOptions)).not.toThrow();
  });

  test('one heartbeat seeds the history with E ± E/4: mean E, deviation a quarter of it', () => {
    // auto follows the cadence, so E = 500 ms and the deviation is 125 ms —
    // above the 100 ms floor, which only a cadence under 400 ms would reach.
    const detectorOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(500)
      .withAcceptableHeartbeatPauseMs(0);
    const fd = new PhiAccrualFailureDetector(detectorOptions);
    const peer = addr(10);
    fd.heartbeat(peer, 0);

    // Against the floor alone (mean 500, σ 100) these were 1 062 / 1 204.
    expectCrossings(crossingsAfter(fd, peer, 0), 1_202, 1_380);
  });

  test('a peer heard from by other frames only is judged with the same estimate', () => {
    const detectorOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(500)
      .withAcceptableHeartbeatPauseMs(0);
    const fd = new PhiAccrualFailureDetector(detectorOptions);
    const peer = addr(11);
    fd.heardFrom(peer, 0);

    expectCrossings(crossingsAfter(fd, peer, 0), 1_202, 1_380);
  });

  test('the seeds are samples, and real ones wash them out', () => {
    // Two heartbeats a cadence apart: [375, 625, 500] — σ ≈ 102 ms, so the
    // window is already almost the floor's.  A pre-sample prior that vanished
    // at the first real interval would read 1 062 / 1 204 here instead.
    const detectorOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(500)
      .withAcceptableHeartbeatPauseMs(0);
    const fd = new PhiAccrualFailureDetector(detectorOptions);
    const peer = addr(12);
    fd.heartbeat(peer, 0);
    fd.heartbeat(peer, 500);

    expectCrossings(crossingsAfter(fd, peer, 500), 1_073, 1_219);
  });

  test('a number decouples the estimate from the cadence; auto is the cadence', () => {
    const explicitOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(500)
      .withExpectedResponseAfterMs(2_000)
      .withAcceptableHeartbeatPauseMs(3_000);
    const followsCadenceOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(2_000)
      .withAcceptableHeartbeatPauseMs(3_000);
    const explicit = new PhiAccrualFailureDetector(explicitOptions);
    const followsCadence = new PhiAccrualFailureDetector(followsCadenceOptions);
    const peer = addr(13);
    explicit.heartbeat(peer, 0);
    followsCadence.heartbeat(peer, 0);

    // E = 2 s, σ₀ = 500 ms, and the pause on top.
    expectCrossings(crossingsAfter(explicit, peer, 0), 7_807, 8_518);
    expect(crossingsAfter(explicit, peer, 0)).toEqual(crossingsAfter(followsCadence, peer, 0));
    // The estimate moved; the cadence the cluster schedules from did not.
    expect(explicit.interval).toBe(500);
  });

  test('a registered peer never heard from is judged from its registration, with the same estimate', () => {
    // The cluster registers a member it learns of through gossip before
    // anything has arrived from it.  φ used to answer 0 for such a peer
    // forever — still healthy an hour later — where the simple detector
    // downs it five seconds after registration.
    const detectorOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(500)
      .withAcceptableHeartbeatPauseMs(0);
    const fd = new PhiAccrualFailureDetector(detectorOptions);
    const peer = addr(14);
    fd.register(peer, 1_000);

    expectCrossings(crossingsAfter(fd, peer, 1_000), 1_202, 1_380);
    expect(fd.decide(peer, 1_000 + 60 * 60_000)).toBe('down');
    // Judged, but not heard: nothing has arrived, so there is no last-seen.
    expect(fd.lastSeen(peer).isNone()).toBe(true);
  });

  test('at shipped settings a registered peer never heard from is unreachable ~4.2 s after registration', () => {
    const fd = new PhiAccrualFailureDetector();
    const peer = addr(16);
    fd.register(peer, 0);

    expectCrossings(crossingsAfter(fd, peer, 0), 4_202, 4_380);
  });

  test('registering a peer already heard from changes nothing', () => {
    const detectorOptions = PhiAccrualOptions.create()
      .withHeartbeatIntervalMs(500)
      .withAcceptableHeartbeatPauseMs(0);
    const fd = new PhiAccrualFailureDetector(detectorOptions);
    const peer = addr(15);
    fd.heartbeat(peer, 0);
    fd.register(peer, 900);

    // Silence is still measured from the heartbeat, not from the later register.
    expectCrossings(crossingsAfter(fd, peer, 0), 1_202, 1_380);
  });
});

describe('the tolerance the shipped settings give (#1452)', () => {
  /** A clean series at the shipped 500 ms cadence: 40 beats, so the history is real samples, not the seeds. */
  function afterCleanSeries(fd: PhiAccrualFailureDetector, peer: NodeAddress): number {
    const beats = 40;
    for (let beat = 0; beat <= beats; beat++) fd.heartbeat(peer, beat * 500);
    return beats * 500;
  }

  test('a clean 500 ms series: unreachable after ~4 062 ms and down after ~4 204 ms of silence', () => {
    // The 3 s pause is a pure offset on the floor-bound tail: 500 ms mean,
    // 100 ms deviation, 5.6 σ to φ = 8 and 7.0 σ to φ = 12, then the pause.
    const fd = new PhiAccrualFailureDetector();
    const peer = addr(20);
    const last = afterCleanSeries(fd, peer);

    expectCrossings(crossingsAfter(fd, peer, last), 4_062, 4_204);
  });

  test('first contact: one heartbeat reads unreachable after ~4 202 ms and down after ~4 380 ms', () => {
    // σ₀ = E/4 = 125 ms rather than the floor: the seeded E ± E/4.
    const fd = new PhiAccrualFailureDetector();
    const peer = addr(21);
    fd.heartbeat(peer, 0);

    expectCrossings(crossingsAfter(fd, peer, 0), 4_202, 4_380);
  });

  test('each second of pause moves both crossings by a second', () => {
    for (const [pauseMs, unreachable, down] of [[0, 1_062, 1_204], [1_000, 2_062, 2_204], [4_000, 5_062, 5_204]] as const) {
      const pausedOptions = PhiAccrualOptions.create().withAcceptableHeartbeatPauseMs(pauseMs);
      const fd = new PhiAccrualFailureDetector(pausedOptions);
      const peer = addr(22);
      const last = afterCleanSeries(fd, peer);

      expectCrossings(crossingsAfter(fd, peer, last), unreachable, down);
    }
  });

  test('a 2 s cadence moves the first-contact estimate with it: ~7 807 / ~8 518 ms', () => {
    // expected-response-after = auto follows the cadence the detector is given.
    const slowCadenceOptions = PhiAccrualOptions.create().withHeartbeatIntervalMs(2_000);
    const fd = new PhiAccrualFailureDetector(slowCadenceOptions);
    const peer = addr(23);
    fd.heartbeat(peer, 0);

    expectCrossings(crossingsAfter(fd, peer, 0), 7_807, 8_518);
  });

  test('min-std-deviation stays at 100 ms: the pause carries the tolerance, the floor keeps its meaning', () => {
    // Raising the floor instead would scale the tolerance with the thresholds
    // and blunt detection for a genuinely steady peer; the pause is an offset
    // that leaves the shape of the tail alone.
    expect(defaultPhiAccrualOptions.minStdDeviationMs).toBe(100);
    expect(defaultPhiAccrualOptions.acceptableHeartbeatPauseMs).toBe(3_000);
  });
});
