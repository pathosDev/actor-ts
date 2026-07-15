/**
 * Per-connection WebSocket policy — the knobs that govern inbound frame
 * limits and outbound backpressure.  Resolved once per route (on the
 * first connection) as: route options > HOCON (`actor-ts.http.websocket`)
 * > built-in defaults.  The codec and target ref are code, never config.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
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

/**
 * Validates the per-connection policy knobs — from any path (route options,
 * HOCON, defaults) since it runs on the fully-resolved policy.  Rejections
 * throw `OptionsError`, replacing the earlier HOCON-only bare-`Error` enum
 * guard.  `maxConnections` admits `Infinity` (the unlimited default), which
 * the generic `positiveInt` helper rejects, so its rule is bespoke.
 */
export class WebsocketPolicyOptionsValidator extends OptionsValidator<WebsocketPolicyOptions> {
  constructor() {
    super('WebsocketPolicyOptions');
  }
  protected rules(s: Partial<WebsocketPolicyOptions>): void {
    this.positiveInt('maxFrameBytes');
    this.positiveInt('maxBufferedBytes');
    this.oneOf('onOversizeFrame', ['close', 'drop']);
    this.oneOf('onInvalidMessage', ['close', 'drop', 'hook']);
    this.oneOf('onBackpressure', ['drop', 'close']);
    const { maxConnections } = s;
    if (
      maxConnections !== undefined && maxConnections !== Infinity &&
      (typeof maxConnections !== 'number' || !Number.isInteger(maxConnections) || maxConnections < 1)
    ) {
      this.fail('maxConnections', 'must be a positive integer or Infinity', maxConnections);
    }
  }
}

/** Merge built-in defaults, HOCON server defaults, and per-route options. */
export function resolveWebsocketPolicy(system: ActorSystem, options: WebsocketPolicyOptions): ResolvedWebsocketPolicy {
  let base = DEFAULT_WEBSOCKET_POLICY;
  const key = ConfigKeys.http.websocket;
  if (system.config.hasPath(key)) {
    const config = system.config.getConfig(key);
    // Read HOCON leaves as-is (a bad enum flows through as a plain string and
    // is caught below by the validator as an OptionsError, not a bare Error).
    base = {
      maxFrameBytes: config.hasPath('maxFrameBytes') ? config.getBytes('maxFrameBytes') : base.maxFrameBytes,
      onOversizeFrame: config.hasPath('onOversizeFrame')
        ? (config.getString('onOversizeFrame') as OversizeFramePolicy)
        : base.onOversizeFrame,
      onInvalidMessage: config.hasPath('onInvalidMessage')
        ? (config.getString('onInvalidMessage') as InvalidMessagePolicy)
        : base.onInvalidMessage,
      maxBufferedBytes: config.hasPath('maxBufferedBytes') ? config.getBytes('maxBufferedBytes') : base.maxBufferedBytes,
      onBackpressure: config.hasPath('onBackpressure')
        ? (config.getString('onBackpressure') as BackpressurePolicy)
        : base.onBackpressure,
      maxConnections: config.hasPath('maxConnections') ? config.getInt('maxConnections') : base.maxConnections,
    };
  }
  const resolved: ResolvedWebsocketPolicy = {
    maxFrameBytes: options.maxFrameBytes ?? base.maxFrameBytes,
    onOversizeFrame: options.onOversizeFrame ?? base.onOversizeFrame,
    onInvalidMessage: options.onInvalidMessage ?? base.onInvalidMessage,
    maxBufferedBytes: options.maxBufferedBytes ?? base.maxBufferedBytes,
    onBackpressure: options.onBackpressure ?? base.onBackpressure,
    maxConnections: options.maxConnections ?? base.maxConnections,
  };
  new WebsocketPolicyOptionsValidator().validate(resolved);
  return resolved;
}
