import { describe, expect, test } from 'bun:test';
import { Config } from '../../../../src/config/Config.js';
import type { ActorSystem } from '../../../../src/ActorSystem.js';
import {
  DEFAULT_WEBSOCKET_POLICY,
  resolveWebsocketPolicy,
} from '../../../../src/http/websocket/WebsocketPolicy.js';

/** Minimal ActorSystem stand-in — resolveWebsocketPolicy only reads `.config`. */
function systemWith(hocon: string): ActorSystem {
  return { config: Config.parseString(hocon) } as unknown as ActorSystem;
}

describe('resolveWebsocketPolicy', () => {
  test('no config, no options → built-in defaults', () => {
    const sys = systemWith('');
    expect(resolveWebsocketPolicy(sys, {})).toEqual(DEFAULT_WEBSOCKET_POLICY);
  });

  test('HOCON overrides the defaults', () => {
    const sys = systemWith(`
      actor-ts.http.websocket {
        maxFrameBytes = 512KiB
        onOversizeFrame = "drop"
        onInvalidMessage = "drop"
        maxBufferedBytes = 8MiB
        onBackpressure = "close"
      }
    `);
    const policy = resolveWebsocketPolicy(sys, {});
    expect(policy.maxFrameBytes).toBe(512 * 1024);
    expect(policy.onOversizeFrame).toBe('drop');
    expect(policy.onInvalidMessage).toBe('drop');
    expect(policy.maxBufferedBytes).toBe(8 * 1024 * 1024);
    expect(policy.onBackpressure).toBe('close');
  });

  test('route options win over HOCON (and HOCON over defaults)', () => {
    const sys = systemWith(`
      actor-ts.http.websocket {
        maxFrameBytes = 512KiB
        onInvalidMessage = "drop"
      }
    `);
    const policy = resolveWebsocketPolicy(sys, { maxFrameBytes: 2048, onOversizeFrame: 'drop' });
    // option override
    expect(policy.maxFrameBytes).toBe(2048);
    expect(policy.onOversizeFrame).toBe('drop');
    // HOCON value where no option
    expect(policy.onInvalidMessage).toBe('drop');
    // default where neither
    expect(policy.onBackpressure).toBe(DEFAULT_WEBSOCKET_POLICY.onBackpressure);
  });

  test('partial HOCON leaves the rest at defaults', () => {
    const sys = systemWith('actor-ts.http.websocket.onBackpressure = "close"');
    const policy = resolveWebsocketPolicy(sys, {});
    expect(policy.onBackpressure).toBe('close');
    expect(policy.maxFrameBytes).toBe(DEFAULT_WEBSOCKET_POLICY.maxFrameBytes);
    expect(policy.onInvalidMessage).toBe(DEFAULT_WEBSOCKET_POLICY.onInvalidMessage);
  });

  test('invalid enum value throws a clear error', () => {
    const sys = systemWith('actor-ts.http.websocket.onInvalidMessage = "explode"');
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/onInvalidMessage/);
  });
});
