import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { FailureDetectorOptionsValidator, type FailureDetectorOptionsType } from '../../../src/cluster/FailureDetectorOptions.js';
import {
  ClusterClientReceptionistOptionsValidator,
  type ClusterClientReceptionistOptionsType,
} from '../../../src/cluster/ClusterClientReceptionistOptions.js';
import { WebSocketClientOptionsValidator, type WebSocketClientOptionsType } from '../../../src/http/ws/WebSocketClientOptions.js';
import { ExpressBackendOptionsValidator, type ExpressBackendOptionsType } from '../../../src/http/backend/ExpressBackendOptions.js';
import { HonoBackendOptionsValidator, type HonoBackendOptionsType } from '../../../src/http/backend/HonoBackendOptions.js';

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

describe('WebSocketClientOptionsValidator', () => {
  const check = (s: Partial<WebSocketClientOptionsType>): void =>
    new WebSocketClientOptionsValidator().validate(s);

  test('accepts ws / wss urls, rejects others', () => {
    expect(() => check({ url: 'ws://host:8080/ws' })).not.toThrow();
    expect(() => check({ url: 'wss://host/ws' })).not.toThrow();
    expect(() => check({ url: 'http://host/ws' })).toThrow(OptionsError);
  });

  test('rejects a non-positive maxFrameBytes / pingIntervalMs', () => {
    expect(() => check({ maxFrameBytes: 0 })).toThrow(OptionsError);
    expect(() => check({ pingIntervalMs: -1 })).toThrow(OptionsError);
  });

  test('rejects an unknown onInvalidMessage policy', () => {
    expect(() => check({ onInvalidMessage: 'explode' as unknown as 'drop' })).toThrow(/onInvalidMessage/);
  });
});

describe('HTTP backend option validators', () => {
  test('Express rejects a non-positive maxBodyBytes', () => {
    const check = (s: Partial<ExpressBackendOptionsType>): void =>
      new ExpressBackendOptionsValidator().validate(s);
    expect(() => check({ maxBodyBytes: 0 })).toThrow(OptionsError);
    expect(() => check({ maxBodyBytes: 1 << 20 })).not.toThrow();
  });

  test('Hono rejects a non-positive maxBodyBytes', () => {
    const check = (s: Partial<HonoBackendOptionsType>): void =>
      new HonoBackendOptionsValidator().validate(s);
    expect(() => check({ maxBodyBytes: -5 })).toThrow(OptionsError);
  });
});
