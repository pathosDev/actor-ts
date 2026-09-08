import { describe, expect, test } from 'bun:test';
import {
  FailureDetector,
  FailureDetectorOptions,
  createFailureDetector,
  defaultFailureDetectorOptions,
} from '../../../src/cluster/index.js';
import { PhiAccrualFailureDetector } from '../../../src/cluster/PhiAccrualFailureDetector.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

/**
 * #1424 — a failure detector reads the clock it was built with.
 *
 * Before that it read `Date.now()` unconditionally, and the consequence was
 * larger than it sounds.  The cluster schedules its heartbeat and detection
 * ticks on `system.scheduler`, so under a `ManualScheduler` virtual time drives
 * them — but the detector those ticks fed read the wall clock, so a hundred
 * advanced ticks delivered a hundred heartbeats that all arrived at the same
 * real instant.  A detector handed a hundred samples with no elapsed time
 * between them concludes nothing, which is why "this peer went quiet for a
 * minute" could not be written as a test at all.
 *
 * Every case here runs in a few milliseconds of real time and asserts on
 * minutes of virtual time.  That is the property, not an optimisation.
 */

const peer = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);

const thresholds = FailureDetectorOptions.create()
  .withUnreachableAfterMs(2_000)
  .withDownAfterMs(5_000);

describe('FailureDetector takes its time from its Clock', () => {
  test('silence measured in virtual time crosses the thresholds', () => {
    const scheduler = new ManualScheduler();
    const detector = new FailureDetector(thresholds, scheduler);
    const target = peer(2551);

    detector.heartbeat(target);
    expect(detector.decide(target)).toBe('healthy');

    scheduler.advance(2_000);
    expect(detector.decide(target)).toBe('unreachable');

    scheduler.advance(3_000);
    expect(detector.decide(target)).toBe('down');
  });

  test('no real time passes while five virtual seconds do', () => {
    // The claim above is only interesting if the wall clock stayed put.
    const scheduler = new ManualScheduler();
    const detector = new FailureDetector(thresholds, scheduler);
    const target = peer(2552);
    const realStart = Date.now();

    detector.heartbeat(target);
    scheduler.advance(5_000);

    expect(detector.decide(target)).toBe('down');
    expect(Date.now() - realStart).toBeLessThan(1_000);
  });

  test('an explicit `now` still wins, for a test that wants to name the instant', () => {
    const scheduler = new ManualScheduler();
    const detector = new FailureDetector(thresholds, scheduler);
    const target = peer(2553);

    detector.heartbeat(target, 100_000);
    // The clock says 0 and the sample says 100 000, so a verdict read off the
    // clock would be nonsense; naming the instant is what makes it answerable.
    expect(detector.decide(target, 105_000)).toBe('down');
  });

  test('lastSeen records the virtual instant, not the wall clock', () => {
    const scheduler = new ManualScheduler();
    const detector = new FailureDetector(thresholds, scheduler);
    const target = peer(2554);

    scheduler.advance(7_000);
    detector.heartbeat(target);

    const seen = detector.lastSeen(target);
    expect(seen.isSome()).toBe(true);
    expect(seen.isSome() ? seen.value : -1).toBe(7_000);
  });

  test('the wall clock is still the default, so nothing outside a test changes', () => {
    const detector = new FailureDetector(thresholds);
    const target = peer(2555);
    const before = Date.now();
    detector.heartbeat(target);

    const seen = detector.lastSeen(target);
    expect(seen.isSome() ? seen.value : -1).toBeGreaterThanOrEqual(before);
    expect(seen.isSome() ? seen.value : -1).toBeLessThanOrEqual(Date.now());
  });
});

describe('PhiAccrualFailureDetector takes its time from its Clock', () => {
  test('a peer that stops heartbeating goes down in virtual time', () => {
    const scheduler = new ManualScheduler();
    const detector = new PhiAccrualFailureDetector({ heartbeatIntervalMs: 100 }, scheduler);
    const target = peer(2556);

    // A regular rhythm first, so the detector has a distribution to reason from
    // rather than only its bootstrap guess.
    for (let beat = 0; beat < 50; beat++) {
      detector.heartbeat(target);
      scheduler.advance(100);
    }
    expect(detector.decide(target)).toBe('healthy');

    // Then silence, far outside anything the samples suggest.
    scheduler.advance(60_000);
    expect(detector.decide(target)).toBe('down');
  });

  test('phi rises with virtual silence', () => {
    const scheduler = new ManualScheduler();
    const detector = new PhiAccrualFailureDetector({ heartbeatIntervalMs: 100 }, scheduler);
    const target = peer(2557);

    for (let beat = 0; beat < 50; beat++) {
      detector.heartbeat(target);
      scheduler.advance(100);
    }
    const fresh = detector.phi(target);
    scheduler.advance(10_000);

    expect(detector.phi(target)).toBeGreaterThan(fresh);
  });
});

describe('createFailureDetector passes the clock through', () => {
  // The factory is the only construction site the cluster uses, so a clock that
  // stopped at this boundary would leave every detector in a real cluster on
  // the wall clock while every direct-construction test looked fine.
  test.each(['simple', 'phi'] as const)('%s', (implementation) => {
    const scheduler = new ManualScheduler();
    const detector = createFailureDetector(
      implementation,
      { ...defaultFailureDetectorOptions, unreachableAfterMs: 2_000, downAfterMs: 5_000 },
      { heartbeatIntervalMs: 100 },
      scheduler,
    );
    const target = peer(2558);

    detector.heartbeat(target);
    scheduler.advance(60_000);

    expect(detector.decide(target)).toBe('down');
    expect(detector.lastSeen(target).isSome()).toBe(true);
  });
});
