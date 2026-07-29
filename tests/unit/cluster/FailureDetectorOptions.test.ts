import { describe, expect, test } from 'bun:test';
import {
  FailureDetector,
  FailureDetectorOptions,
  FailureDetectorOptionsValidator,
  defaultFailureDetectorOptions,
} from '../../../src/cluster/index.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const peer = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);

describe('FailureDetector — threshold semantics (#452)', () => {
  test('downAfterMs is measured from the last heartbeat, not added to unreachableAfterMs', () => {
    // This is the behaviour the JSDoc used to contradict by calling
    // downAfterMs "additional time".  Both thresholds are compared against the
    // same elapsed silence, so with 2s/5s a peer is unreachable between 2s and
    // 5s and down from 5s — it is not down at 2+5=7s.
    const detector = new FailureDetector(
      FailureDetectorOptions.create()
        .withHeartbeatIntervalMs(500)
        .withUnreachableAfterMs(2_000)
        .withDownAfterMs(5_000),
    );
    const node = peer(2551);
    detector.heartbeat(node, 0);

    expect(detector.decide(node, 1_999)).toBe('healthy');
    expect(detector.decide(node, 2_000)).toBe('unreachable');
    expect(detector.decide(node, 4_999)).toBe('unreachable');
    expect(detector.decide(node, 5_000)).toBe('down');
    expect(detector.decide(node, 7_000)).toBe('down');
  });

  test('a peer spends downAfterMs - unreachableAfterMs in the unreachable state', () => {
    const detector = new FailureDetector(
      FailureDetectorOptions.create()
        .withUnreachableAfterMs(1_000)
        .withDownAfterMs(1_500),
    );
    const node = peer(2552);
    detector.heartbeat(node, 0);

    expect(detector.decide(node, 1_000)).toBe('unreachable');
    expect(detector.decide(node, 1_499)).toBe('unreachable');
    expect(detector.decide(node, 1_500)).toBe('down');
  });
});

describe('FailureDetectorOptionsValidator — ordering rule (#452)', () => {
  test('rejects downAfterMs equal to unreachableAfterMs', () => {
    // `decide` tests `down` before `unreachable`, so an equal value makes the
    // unreachable branch dead code — the peer skips straight to down and the
    // state that lets a transient blip recover never happens.  Nothing used to
    // reject this.
    const options = FailureDetectorOptions.create()
      .withUnreachableAfterMs(3_000)
      .withDownAfterMs(3_000);
    expect(() => new FailureDetector(options)).toThrow(OptionsError);
    expect(() => new FailureDetector(options)).toThrow(/greater than unreachableAfterMs/);
  });

  test('rejects downAfterMs smaller than unreachableAfterMs', () => {
    const options = FailureDetectorOptions.create()
      .withUnreachableAfterMs(3_000)
      .withDownAfterMs(2_000);
    expect(() => new FailureDetector(options)).toThrow(OptionsError);
  });

  test('the error names the offending field and both values', () => {
    try {
      new FailureDetectorOptionsValidator().validate({
        heartbeatIntervalMs: 500,
        unreachableAfterMs: 4_000,
        downAfterMs: 1_000,
      });
      throw new Error('expected the validator to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(OptionsError);
      expect((e as OptionsError).message).toContain('downAfterMs');
      expect((e as OptionsError).message).toContain('4000');
      expect((e as OptionsError).message).toContain('1000');
    }
  });

  test('accepts a valid ordering and the built-in defaults', () => {
    expect(() => new FailureDetector(
      FailureDetectorOptions.create()
        .withUnreachableAfterMs(2_000)
        .withDownAfterMs(5_000),
    )).not.toThrow();

    expect(defaultFailureDetectorOptions.downAfterMs)
      .toBeGreaterThan(defaultFailureDetectorOptions.unreachableAfterMs);
    expect(() => new FailureDetector()).not.toThrow();
  });

  test('an unset threshold still falls through to the defaults', () => {
    // Only one field set: the merge fills the rest, and the cross-field rule
    // must not fire on the partial input.
    expect(() => new FailureDetector(
      FailureDetectorOptions.create().withHeartbeatIntervalMs(250),
    )).not.toThrow();
  });
});
