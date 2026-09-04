import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../../src/config/Config.js';
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
        max-frame-bytes = 512KiB
        on-oversize-frame = "drop"
        on-invalid-message = "drop"
        max-buffered-bytes = 8MiB
        on-backpressure = "close"
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
        max-frame-bytes = 512KiB
        on-invalid-message = "drop"
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
    const sys = systemWith('actor-ts.http.websocket.on-backpressure = "close"');
    const policy = resolveWebsocketPolicy(sys, {});
    expect(policy.onBackpressure).toBe('close');
    expect(policy.maxFrameBytes).toBe(DEFAULT_WEBSOCKET_POLICY.maxFrameBytes);
    expect(policy.onInvalidMessage).toBe(DEFAULT_WEBSOCKET_POLICY.onInvalidMessage);
  });

  test('invalid enum value throws a clear error', () => {
    const sys = systemWith('actor-ts.http.websocket.on-invalid-message = "explode"');
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(/onInvalidMessage/);
  });

  /**
   * #1405 kebab-cased the nine leaves in this block.  Six of them are caps a
   * semi-trusted deployment lowers on purpose (`docs/http/security.mdx` says
   * so about this very one), so an unread old spelling would restore the
   * framework default with nothing said.  Rejecting names both spellings; the
   * `duration` variant is here too because dropping the `Ms` is the one rename
   * a reader would not guess from kebab-casing alone.
   */
  test.each([
    ['maxFrameBytes = 512KiB', 'maxFrameBytes', 'max-frame-bytes'],
    ['acceptTimeoutMs = 30s', 'acceptTimeoutMs', 'accept-timeout'],
    ['maxConnections = 10', 'maxConnections', 'max-connections'],
  ])('a retired %s is refused, naming both spellings', (assignment, retired, current) => {
    const sys = systemWith(`actor-ts.http.websocket { ${assignment} }`);
    expect(() => resolveWebsocketPolicy(sys, {})).toThrow(ConfigError);
    expect(() => resolveWebsocketPolicy(sys, {}))
      .toThrow(new RegExp(`actor-ts\\.http\\.websocket\\.${retired}[\\s\\S]*actor-ts\\.http\\.websocket\\.${current}`));
  });

  test('the kebab spellings of those same three are read', () => {
    // Guards the guard above: a resolver that threw on any configured leaf
    // would satisfy it, so the accepted half has to be pinned too.
    const sys = systemWith(`
      actor-ts.http.websocket {
        max-frame-bytes = 512KiB
        accept-timeout = 30s
        max-connections = 10
      }
    `);
    const policy = resolveWebsocketPolicy(sys, {});
    expect(policy.maxFrameBytes).toBe(512 * 1024);
    expect(policy.acceptTimeoutMs).toBe(30_000);
    expect(policy.maxConnections).toBe(10);
  });
});
