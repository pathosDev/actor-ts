/**
 * Per-connection WebSocket policy — the knobs that govern inbound frame
 * limits and outbound backpressure.  Resolved once per route (on the
 * first connection) as: route options > HOCON (`actor-ts.http.websocket`)
 * > built-in defaults.  The codec and target ref are code, never config.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from './types.js';

/** What to do with an inbound frame that exceeds `maxFrameBytes`. */
export type OversizeFramePolicy = 'close' | 'drop';
/** What to do with an inbound frame the codec can't decode. */
export type InvalidMessagePolicy = 'close' | 'drop' | 'hook';
/** What to do when a slow consumer's send buffer exceeds `maxBufferedBytes`. */
export type BackpressurePolicy = 'drop' | 'close';

export interface ResolvedWebsocketPolicy {
  readonly maxFrameBytes: number;
  readonly onOversizeFrame: OversizeFramePolicy;
  readonly onInvalidMessage: InvalidMessagePolicy;
  readonly maxBufferedBytes: number;
  readonly onBackpressure: BackpressurePolicy;
  /**
   * Max concurrent connections admitted per route.  A new upgrade beyond
   * this is closed with 1013 ("try again later") instead of being wired
   * (security audit WS-5).  `Infinity` (the default) = unlimited.
   */
  readonly maxConnections: number;
}

/** Fields a `websocket()` route may override; everything else falls back. */
export interface WebsocketPolicyOptions {
  readonly maxFrameBytes?: number;
  readonly onOversizeFrame?: OversizeFramePolicy;
  readonly onInvalidMessage?: InvalidMessagePolicy;
  readonly maxBufferedBytes?: number;
  readonly onBackpressure?: BackpressurePolicy;
  readonly maxConnections?: number;
}

export const DEFAULT_WEBSOCKET_POLICY: ResolvedWebsocketPolicy = {
  maxFrameBytes: DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  onOversizeFrame: 'close',
  onInvalidMessage: 'close',
  maxBufferedBytes: 4 * 1024 * 1024,
  onBackpressure: 'drop',
  maxConnections: Infinity,
};

function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `Invalid config value for actor-ts.http.websocket.${key}: "${value}" (expected one of ${allowed.join(', ')})`,
  );
}

/** Merge built-in defaults, HOCON server defaults, and per-route options. */
export function resolveWebsocketPolicy(system: ActorSystem, options: WebsocketPolicyOptions): ResolvedWebsocketPolicy {
  let base = DEFAULT_WEBSOCKET_POLICY;
  const key = ConfigKeys.http.websocket;
  if (system.config.hasPath(key)) {
    const config = system.config.getConfig(key);
    base = {
      maxFrameBytes: config.hasPath('maxFrameBytes') ? config.getBytes('maxFrameBytes') : base.maxFrameBytes,
      onOversizeFrame: config.hasPath('onOversizeFrame')
        ? oneOf(config.getString('onOversizeFrame'), ['close', 'drop'] as const, 'onOversizeFrame')
        : base.onOversizeFrame,
      onInvalidMessage: config.hasPath('onInvalidMessage')
        ? oneOf(config.getString('onInvalidMessage'), ['close', 'drop', 'hook'] as const, 'onInvalidMessage')
        : base.onInvalidMessage,
      maxBufferedBytes: config.hasPath('maxBufferedBytes') ? config.getBytes('maxBufferedBytes') : base.maxBufferedBytes,
      onBackpressure: config.hasPath('onBackpressure')
        ? oneOf(config.getString('onBackpressure'), ['drop', 'close'] as const, 'onBackpressure')
        : base.onBackpressure,
      maxConnections: config.hasPath('maxConnections') ? config.getInt('maxConnections') : base.maxConnections,
    };
  }
  return {
    maxFrameBytes: options.maxFrameBytes ?? base.maxFrameBytes,
    onOversizeFrame: options.onOversizeFrame ?? base.onOversizeFrame,
    onInvalidMessage: options.onInvalidMessage ?? base.onInvalidMessage,
    maxBufferedBytes: options.maxBufferedBytes ?? base.maxBufferedBytes,
    onBackpressure: options.onBackpressure ?? base.onBackpressure,
    maxConnections: options.maxConnections ?? base.maxConnections,
  };
}
