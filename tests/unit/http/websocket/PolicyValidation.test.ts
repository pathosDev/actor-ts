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

  // #1432 — the per-route bound on each connection actor's mailbox.  Unlike
  // maxConnections, Infinity is not a value of it: "no bound" is the unset
  // field, which falls through to a matching actor-ts.deployment entry and
  // then to actor-ts.mailbox.default.* (#868).
  test('connectionMailboxCapacity must be a positive integer, and Infinity is not one', () => {
    const validator = new WebsocketPolicyOptionsValidator();
    expect(() => validator.validate({ connectionMailboxCapacity: 0 })).toThrow(/connectionMailboxCapacity/);
    expect(() => validator.validate({ connectionMailboxCapacity: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ connectionMailboxCapacity: 2.5 })).toThrow(/connectionMailboxCapacity/);
    expect(() => validator.validate({ connectionMailboxCapacity: Infinity })).toThrow(/connectionMailboxCapacity/);
    expect(() => validator.validate({ connectionMailboxCapacity: 256 })).not.toThrow();
  });

  test('connectionMailboxOverflow is one of the three policies, and only beside a capacity', () => {
    const validator = new WebsocketPolicyOptionsValidator();
    expect(() => validator.validate({ connectionMailboxCapacity: 8, connectionMailboxOverflow: 'drop-oldest' as never }))
      .toThrow(/connectionMailboxOverflow/);
    // Alone it is refused — and the message names the field it is missing,
    // because "restate the capacity" is the fix.
    expect(() => validator.validate({ connectionMailboxOverflow: 'drop-new' }))
      .toThrow(/connectionMailboxOverflow[\s\S]*connectionMailboxCapacity/);
    for (const overflow of ['drop-head', 'drop-new', 'reject'] as const) {
      expect(() => validator.validate({ connectionMailboxCapacity: 8, connectionMailboxOverflow: overflow })).not.toThrow();
    }
  });
});

describe('resolveWebsocketPolicy — validates the merged policy', () => {
  test('a bad HOCON max-connections throws OptionsError (not a bare Error)', async () => {
    const sys = systemWith({ 'actor-ts': { http: { websocket: { 'max-connections': 0 } } } });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(OptionsError);
    await sys.terminate();
  });

  test('a bad HOCON enum throws OptionsError', async () => {
    // The message names the *field*, not the leaf — the validator runs on the
    // merged options object, which is TypeScript, so it says `onOversizeFrame`
    // however the leaf that fed it was spelled.
    const sys = systemWith({ 'actor-ts': { http: { websocket: { 'on-oversize-frame': 'explode' } } } });
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
          websocket: {
            'max-pre-attach-frames': 12,
            'max-pre-attach-bytes': '2M',
            'accept-timeout': '30s',
          },
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

  test('a bad HOCON accept-timeout throws OptionsError at resolution', async () => {
    const sys = systemWith({ 'actor-ts': { http: { websocket: { 'accept-timeout': 0 } } } });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/acceptTimeoutMs/);
    await sys.terminate();
  });

  // #1432 — resolution runs at bind().  Left to ActorOptionsValidator, an
  // overflow with no capacity would throw from context.spawn on the hub's
  // stack at the first upgrade, long after the deployment started.
  test('a HOCON connection overflow with no capacity anywhere is refused at resolution', async () => {
    const sys = systemWith({ 'actor-ts': { http: { websocket: { 'connection-mailbox-overflow': 'drop-new' } } } });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(OptionsError);
    await sys.terminate();
  });

  test('a global mailbox capacity does not stand in for the connection one', async () => {
    // The global bound does reach the connection actor — but at spawn, and an
    // overflow named for the connection alone would arrive there without a
    // capacity beside it.  Same rule as ActorOptions: restate the capacity.
    const sys = systemWith({
      'actor-ts': {
        mailbox: { default: { capacity: 4 } },
        http: { websocket: { 'connection-mailbox-overflow': 'drop-new' } },
      },
    });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/connectionMailboxOverflow/);
    await sys.terminate();
  });

  test('the capacity and the overflow may come from different layers', async () => {
    // The rule is about the merged policy: a route that sizes its connections
    // under a deployment that picks the policy is complete.
    const sys = systemWith({ 'actor-ts': { http: { websocket: { 'connection-mailbox-overflow': 'reject' } } } });
    const policy = resolveWebsocketPolicy(sys, { connectionMailboxCapacity: 16 });
    expect(policy.connectionMailboxCapacity).toBe(16);
    expect(policy.connectionMailboxOverflow).toBe('reject');
    await sys.terminate();
  });

  test('a bad HOCON connection capacity throws OptionsError naming the field', async () => {
    const sys = systemWith({ 'actor-ts': { http: { websocket: { 'connection-mailbox-capacity': 0 } } } });
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/connectionMailboxCapacity/);
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
