import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../../src/config/Reference.js';
import type { ActorSystem } from '../../../../src/ActorSystem.js';
import {
  DEFAULT_WEBSOCKET_POLICY,
  readWebsocketPolicyOptionsFromConfig,
  resolveWebsocketPolicy,
  type ResolvedWebsocketPolicy,
} from '../../../../src/http/websocket/WebsocketPolicy.js';
import { expectExactOptions } from '../../../util/ExactOptions.js';

/** Minimal ActorSystem stand-in — resolveWebsocketPolicy only reads `.config`. */
function systemWith(hocon: string): ActorSystem {
  return { config: Config.parseString(hocon) } as unknown as ActorSystem;
}

/**
 * Every leaf of the block, each at a value no other leaf of it carries and
 * that is not its own default — so a read from the wrong key, or no read at
 * all, cannot come out right by coincidence.
 */
const EVERY_LEAF = `
  actor-ts.http.websocket {
    max-frame-bytes       = 512KiB
    on-oversize-frame     = "drop"
    on-invalid-message    = "hook"
    max-buffered-bytes    = 8MiB
    on-backpressure       = "close"
    max-connections       = 10
    max-pre-attach-frames = 12
    max-pre-attach-bytes  = 2MiB
    accept-timeout        = 30s
  }
`;

/** {@link EVERY_LEAF}, read: kebab leaf to camelCase field, units applied. */
const EVERY_LEAF_READ: ResolvedWebsocketPolicy = {
  maxFrameBytes: 512 * 1024,
  onOversizeFrame: 'drop',
  onInvalidMessage: 'hook',
  maxBufferedBytes: 8 * 1024 * 1024,
  onBackpressure: 'close',
  maxConnections: 10,
  maxPreAttachFrames: 12,
  maxPreAttachBytes: 2 * 1024 * 1024,
  acceptTimeoutMs: 30_000,
};

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

  test('each of the nine fields resolves route > HOCON > built-in default', () => {
    // The case above samples four fields; this holds the order for all nine,
    // with the HOCON layer coming through readWebsocketPolicyOptionsFromConfig.
    const sys = systemWith(EVERY_LEAF);
    expect(resolveWebsocketPolicy(sys, {})).toEqual(EVERY_LEAF_READ);
    // Each route value differs from the configured one, so a field that let
    // HOCON win over the route would show.
    const route: ResolvedWebsocketPolicy = {
      maxFrameBytes: 4096,
      onOversizeFrame: 'close',
      onInvalidMessage: 'drop',
      maxBufferedBytes: 16 * 1024,
      onBackpressure: 'drop',
      maxConnections: 3,
      maxPreAttachFrames: 5,
      maxPreAttachBytes: 32 * 1024,
      acceptTimeoutMs: 1_500,
    };
    expect(resolveWebsocketPolicy(sys, route)).toEqual(route);
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

/**
 * The HOCON half on its own, one exact-object case per leaf (#1425).
 *
 * `resolveWebsocketPolicy` folds the block into a fully-resolved policy, so a
 * leaf it stopped reading is answered by the built-in default and every case
 * above that does not set that very leaf passes.  The reader returns only what
 * the file says, which makes a dropped leaf, a read from the wrong key and an
 * unset leaf written as an own `undefined` each a failure naming the field.
 */
describe('readWebsocketPolicyOptionsFromConfig', () => {
  test('reads every leaf of the block, kebab mapped to camelCase', () => {
    expectExactOptions(readWebsocketPolicyOptionsFromConfig(Config.parseString(EVERY_LEAF)), EVERY_LEAF_READ);
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readWebsocketPolicyOptionsFromConfig(Config.parseString('actor-ts.system.name = x')), {});
  });

  test('a partly-set block returns only what was set', () => {
    expectExactOptions(
      readWebsocketPolicyOptionsFromConfig(Config.parseString('actor-ts.http.websocket.on-backpressure = "close"')),
      { onBackpressure: 'close' },
    );
  });

  test('the shipped reference.conf resolves to the documented defaults, max-connections left unset', () => {
    // max-connections is comment-only: its default is Infinity, which HOCON
    // has no literal for, so the reader must not produce the key at all.
    expectExactOptions(readWebsocketPolicyOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      maxFrameBytes: DEFAULT_WEBSOCKET_POLICY.maxFrameBytes,
      onOversizeFrame: DEFAULT_WEBSOCKET_POLICY.onOversizeFrame,
      onInvalidMessage: DEFAULT_WEBSOCKET_POLICY.onInvalidMessage,
      maxBufferedBytes: DEFAULT_WEBSOCKET_POLICY.maxBufferedBytes,
      onBackpressure: DEFAULT_WEBSOCKET_POLICY.onBackpressure,
      maxPreAttachFrames: DEFAULT_WEBSOCKET_POLICY.maxPreAttachFrames,
      maxPreAttachBytes: DEFAULT_WEBSOCKET_POLICY.maxPreAttachBytes,
      acceptTimeoutMs: DEFAULT_WEBSOCKET_POLICY.acceptTimeoutMs,
    });
  });

  test.each([
    ['maxFrameBytes = 512KiB', 'maxFrameBytes', 'max-frame-bytes'],
    ['onOversizeFrame = "drop"', 'onOversizeFrame', 'on-oversize-frame'],
    ['onInvalidMessage = "drop"', 'onInvalidMessage', 'on-invalid-message'],
    ['maxBufferedBytes = 8MiB', 'maxBufferedBytes', 'max-buffered-bytes'],
    ['onBackpressure = "close"', 'onBackpressure', 'on-backpressure'],
    ['maxConnections = 10', 'maxConnections', 'max-connections'],
    ['maxPreAttachFrames = 12', 'maxPreAttachFrames', 'max-pre-attach-frames'],
    ['maxPreAttachBytes = 2MiB', 'maxPreAttachBytes', 'max-pre-attach-bytes'],
    ['acceptTimeoutMs = 30s', 'acceptTimeoutMs', 'accept-timeout'],
  ])('a retired %s is refused by the read itself, naming both spellings', (assignment, retired, current) => {
    const config = Config.parseString(`actor-ts.http.websocket { ${assignment} }`);
    expect(() => readWebsocketPolicyOptionsFromConfig(config)).toThrow(ConfigError);
    expect(() => readWebsocketPolicyOptionsFromConfig(config))
      .toThrow(new RegExp(`actor-ts\\.http\\.websocket\\.${retired}[\\s\\S]*actor-ts\\.http\\.websocket\\.${current}`));
  });
});
