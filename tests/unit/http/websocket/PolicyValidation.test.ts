import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
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

function systemWith(config: Record<string, unknown>): ActorSystem {
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
