import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import {
  resolveWebsocketPolicy,
  WebsocketPolicyOptionsValidator,
} from '../../../../src/http/websocket/WebsocketPolicy.js';
import {
  WebsocketRouteOptions,
  WebsocketRouteOptionsValidator,
} from '../../../../src/http/websocket/WebsocketRouteOptions.js';
import { websocket } from '../../../../src/http/websocket/WebsocketRoute.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';

const target = {} as unknown as WebsocketServerRef<unknown, unknown, never>;

function systemWith(config: ConfigObject): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  return ActorSystem.create('ws-policy-validation', sysOptions);
}

// security audit WS-5 follow-up — before this, the policy knobs were only
// type-checked on the HOCON path (bare Error) and unchecked on the options
// path, so maxConnections 0 / -1 / NaN sailed through with surprising silent
// semantics.  Now the resolved policy is validated (OptionsError) on every path.
describe('WebsocketPolicyOptionsValidator', () => {
  test('rejects a non-positive / non-integer maxConnections; Infinity is allowed', () => {
    const validator = new WebsocketPolicyOptionsValidator();
    expect(() => validator.validate({ maxConnections: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ maxConnections: -1 })).toThrow(/maxConnections/);
    expect(() => validator.validate({ maxConnections: 2.5 })).toThrow(/maxConnections/);
    expect(() => validator.validate({ maxConnections: Number.NaN })).toThrow(/maxConnections/);
    expect(() => validator.validate({ maxConnections: Infinity })).not.toThrow();
    expect(() => validator.validate({ maxConnections: 100 })).not.toThrow();
  });

  test('rejects non-positive byte caps and unknown enum values', () => {
    const validator = new WebsocketPolicyOptionsValidator();
    expect(() => validator.validate({ maxFrameBytes: 0 })).toThrow(/maxFrameBytes/);
    expect(() => validator.validate({ maxBufferedBytes: -1 })).toThrow(/maxBufferedBytes/);
    expect(() => validator.validate({ onOversizeFrame: 'boom' as never })).toThrow(/onOversizeFrame/);
    expect(() => validator.validate({ onInvalidMessage: 'nope' as never })).toThrow(OptionsError);
  });

  // #717 — the pre-attach buffer bound is a security cap, so "off" is not one
  // of its values: unlike maxConnections and acceptTimeoutMs, neither half
  // admits Infinity.
  test('rejects a non-positive pre-attach bound, and does not admit Infinity', () => {
    const validator = new WebsocketPolicyOptionsValidator();
    expect(() => validator.validate({ maxPreAttachFrames: 0 })).toThrow(/maxPreAttachFrames/);
    expect(() => validator.validate({ maxPreAttachFrames: 2.5 })).toThrow(OptionsError);
    expect(() => validator.validate({ maxPreAttachFrames: Infinity })).toThrow(/maxPreAttachFrames/);
    expect(() => validator.validate({ maxPreAttachBytes: -1 })).toThrow(/maxPreAttachBytes/);
    expect(() => validator.validate({ maxPreAttachBytes: Infinity })).toThrow(/maxPreAttachBytes/);
    expect(() => validator.validate({ maxPreAttachFrames: 8, maxPreAttachBytes: 1024 })).not.toThrow();
  });

  test('acceptTimeoutMs must be a positive integer, or Infinity to disable it', () => {
    const validator = new WebsocketPolicyOptionsValidator();
    expect(() => validator.validate({ acceptTimeoutMs: 0 })).toThrow(/acceptTimeoutMs/);
    expect(() => validator.validate({ acceptTimeoutMs: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ acceptTimeoutMs: 1.5 })).toThrow(/acceptTimeoutMs/);
    expect(() => validator.validate({ acceptTimeoutMs: Number.NaN })).toThrow(/acceptTimeoutMs/);
    expect(() => validator.validate({ acceptTimeoutMs: Infinity })).not.toThrow();
    expect(() => validator.validate({ acceptTimeoutMs: 30_000 })).not.toThrow();
  });
});

describe('resolveWebsocketPolicy — validates the merged policy', () => {
  test('a bad HOCON maxConnections throws OptionsError (not a bare Error)', async () => {
    const sys = systemWith({ 'actor-ts': { http: { websocket: { maxConnections: 0 } } } });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(OptionsError);
    await sys.terminate();
  });

  test('a bad HOCON enum throws OptionsError', async () => {
    const sys = systemWith({ 'actor-ts': { http: { websocket: { onOversizeFrame: 'explode' } } } });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/onOversizeFrame/);
    await sys.terminate();
  });

  test('route options override HOCON and are validated too', async () => {
    const sys = systemWith({});
    expect(() => resolveWebsocketPolicy(sys, { maxConnections: -5 })).toThrow(OptionsError);
    expect(resolveWebsocketPolicy(sys, { maxConnections: 10 }).maxConnections).toBe(10);
    await sys.terminate();
  });

  test('the #717 leaves resolve from HOCON, with their units (bytes, duration)', async () => {
    const sys = systemWith({
      'actor-ts': {
        http: {
          websocket: { maxPreAttachFrames: 12, maxPreAttachBytes: '2M', acceptTimeoutMs: '30s' },
        },
      },
    });
    const policy = resolveWebsocketPolicy(sys, {});
    expect(policy.maxPreAttachFrames).toBe(12);
    expect(policy.maxPreAttachBytes).toBe(2 * 1024 * 1024);
    // `getDuration`, so an operator writes "30s" rather than counting zeroes —
    // the `Ms` in the field name is for the code side, which has no unit of
    // its own to read.
    expect(policy.acceptTimeoutMs).toBe(30_000);
    await sys.terminate();
  });

  test('a bad HOCON acceptTimeoutMs throws OptionsError at resolution', async () => {
    const sys = systemWith({ 'actor-ts': { http: { websocket: { acceptTimeoutMs: 0 } } } });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/acceptTimeoutMs/);
    await sys.terminate();
  });
});

describe('WebsocketRouteOptionsValidator — allowedOrigins', () => {
  test('rejects a non-array or empty / non-string entries; empty array is allowed', () => {
    const validator = new WebsocketRouteOptionsValidator();
    expect(() => validator.validate({ allowedOrigins: 'https://x' as never })).toThrow(/allowedOrigins/);
    expect(() => validator.validate({ allowedOrigins: ['https://x', ''] })).toThrow(OptionsError);
    expect(() => validator.validate({ allowedOrigins: [] })).not.toThrow();          // empty = no guard
    expect(() => validator.validate({ allowedOrigins: ['https://x'] })).not.toThrow();
  });

  test('websocket() validates allowedOrigins at definition time', () => {
    expect(() => websocket('/ws', target, { allowedOrigins: [''] })).toThrow(/allowedOrigins/);
    const routeOptions = WebsocketRouteOptions.create().withAllowedOrigins(['https://ok']);
    expect(() => websocket('/ws', target, routeOptions)).not.toThrow();
  });
});
