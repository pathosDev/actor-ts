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
    const p = resolveWebsocketPolicy(sys, {});
    expect(p.maxFrameBytes).toBe(512 * 1024);
    expect(p.onOversizeFrame).toBe('drop');
    expect(p.onInvalidMessage).toBe('drop');
    expect(p.maxBufferedBytes).toBe(8 * 1024 * 1024);
    expect(p.onBackpressure).toBe('close');
  });

  test('route options win over HOCON (and HOCON over defaults)', () => {
    const sys = systemWith(`
      actor-ts.http.websocket {
        maxFrameBytes = 512KiB
        onInvalidMessage = "drop"
      }
    `);
    const p = resolveWebsocketPolicy(sys, { maxFrameBytes: 2048, onOversizeFrame: 'drop' });
    // option override
    expect(p.maxFrameBytes).toBe(2048);
    expect(p.onOversizeFrame).toBe('drop');
    // HOCON value where no option
    expect(p.onInvalidMessage).toBe('drop');
    // default where neither
    expect(p.onBackpressure).toBe(DEFAULT_WEBSOCKET_POLICY.onBackpressure);
  });

  test('partial HOCON leaves the rest at defaults', () => {
    const sys = systemWith('actor-ts.http.websocket.onBackpressure = "close"');
    const p = resolveWebsocketPolicy(sys, {});
    expect(p.onBackpressure).toBe('close');
    expect(p.maxFrameBytes).toBe(DEFAULT_WEBSOCKET_POLICY.maxFrameBytes);
    expect(p.onInvalidMessage).toBe(DEFAULT_WEBSOCKET_POLICY.onInvalidMessage);
  });

  test('invalid enum value throws a clear error', () => {
    const sys = systemWith('actor-ts.http.websocket.onInvalidMessage = "explode"');
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/onInvalidMessage/);
  });
});
