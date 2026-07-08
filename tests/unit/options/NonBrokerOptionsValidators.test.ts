import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { FailureDetectorOptionsValidator, type FailureDetectorOptionsType } from '../../../src/cluster/FailureDetectorOptions.js';
import {
  ClusterClientReceptionistOptionsValidator,
  type ClusterClientReceptionistOptionsType,
} from '../../../src/cluster/ClusterClientReceptionistOptions.js';

// Direct validator tests for the non-broker options. Each consumer calls the
// same validator in its constructor / start method after merging defaults.

describe('FailureDetectorOptionsValidator', () => {
  const check = (s: Partial<FailureDetectorOptionsType>): void =>
    new FailureDetectorOptionsValidator().validate(s);

  test('rejects a non-positive threshold', () => {
    expect(() => check({ heartbeatIntervalMs: 0 })).toThrow(OptionsError);
    expect(() => check({ unreachableAfterMs: -1 })).toThrow(OptionsError);
    expect(() => check({ downAfterMs: 0 })).toThrow(OptionsError);
  });

  test('accepts positive thresholds (defaults are valid)', () => {
    expect(() => check({ heartbeatIntervalMs: 500, unreachableAfterMs: 2_000, downAfterMs: 5_000 }))
      .not.toThrow();
  });
});

describe('ClusterClientReceptionistOptionsValidator', () => {
  const check = (s: Partial<ClusterClientReceptionistOptionsType>): void =>
    new ClusterClientReceptionistOptionsValidator().validate(s);

  test('rejects a non-positive askTimeoutMs', () => {
    expect(() => check({ askTimeoutMs: 0 })).toThrow(OptionsError);
  });

  test('accepts an unset or positive askTimeoutMs', () => {
    expect(() => check({})).not.toThrow();
    expect(() => check({ askTimeoutMs: 3_000 })).not.toThrow();
  });
});
