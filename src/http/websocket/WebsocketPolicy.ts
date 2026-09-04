/**
 * Per-connection WebSocket policy — the knobs that govern inbound frame
 * limits and outbound backpressure.  Resolved once per route (on the
 * first connection) as: route options > HOCON (`actor-ts.http.websocket`)
 * > built-in defaults.  The codec and target ref are code, never config.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { rejectRetiredLeaves, type RetiredLeaves } from '../../config/RetiredKeys.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import {
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES,
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES,
} from '../Constants.js';

/** What to do with an inbound frame that exceeds `maxFrameBytes`. */
export type OversizeFramePolicy = 'close' | 'drop';
/** What to do with an inbound frame the codec can't decode. */
export type InvalidMessagePolicy = 'close' | 'drop' | 'hook';
/** What to do when a slow consumer's send buffer exceeds `maxBufferedBytes`. */
export type BackpressurePolicy = 'drop' | 'close';

export type ResolvedWebsocketPolicy = {
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
  /**
   * Inbound frames held between the upgrade completing and the connection
   * actor attaching its listeners.  Past this the socket is closed with 1013
   * (#717) — see `bufferWebsocketEvents`, which owns the accounting.
   */
  readonly maxPreAttachFrames: number;
  /** The byte half of {@link maxPreAttachFrames}; the first frame is exempt. */
  readonly maxPreAttachBytes: number;
  /**
   * How long an admitted upgrade may wait for its connection actor to attach
   * before the socket is closed and its `maxConnections` slot released.
   *
   * The fallback for every way the accept can fail to produce an actor that
   * `wireConnection` cannot see synchronously: a hub that stops between the
   * send and the drain, one whose `onReceive` an application overrode without
   * handling `websocket-accept`, a spawn that throws.  All of them leave an
   * upgraded socket with no listeners, and nothing else ever revisits it.
   *
   * `Infinity` disables the watchdog.
   */
  readonly acceptTimeoutMs: number;
};

/** Fields a `websocket()` route may override; everything else falls back. */
export type WebsocketPolicyOptions = {
  readonly maxFrameBytes?: number;
  readonly onOversizeFrame?: OversizeFramePolicy;
  readonly onInvalidMessage?: InvalidMessagePolicy;
  readonly maxBufferedBytes?: number;
  readonly onBackpressure?: BackpressurePolicy;
  readonly maxConnections?: number;
  readonly maxPreAttachFrames?: number;
  readonly maxPreAttachBytes?: number;
  readonly acceptTimeoutMs?: number;
};

export const DEFAULT_WEBSOCKET_POLICY: ResolvedWebsocketPolicy = {
  maxFrameBytes: DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  onOversizeFrame: 'close',
  onInvalidMessage: 'close',
  maxBufferedBytes: 4 * 1024 * 1024,
  onBackpressure: 'drop',
  maxConnections: Infinity,
  maxPreAttachFrames: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES,
  maxPreAttachBytes: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES,
  // 10 s.  A healthy hub attaches within two mailbox hops, so anything in
  // seconds is already a fallback rather than a liveness policy; and a hub far
  // enough behind to need longer than this is one whose *new* connections are
  // better refused with a 1013 than admitted into a queue they cannot reach.
  // Written here rather than in `Constants.ts` because this file is its only
  // reader — the wiring layer takes it off the resolved policy.
  acceptTimeoutMs: 10_000,
};

/**
 * Validates the per-connection policy knobs — from any path (route options,
 * HOCON, defaults) since it runs on the fully-resolved policy.  Rejections
 * throw `OptionsError`, replacing the earlier HOCON-only bare-`Error` enum
 * guard.  `maxConnections` and `acceptTimeoutMs` both admit `Infinity` — the
 * value each uses to say its bound is off — which the generic `positiveInt`
 * helper rejects, so they share a bespoke rule.
 */
export class WebsocketPolicyOptionsValidator extends OptionsValidator<WebsocketPolicyOptions> {
  constructor() {
    super('WebsocketPolicyOptions');
  }
  protected rules(s: Partial<WebsocketPolicyOptions>): void {
    this.positiveInt('maxFrameBytes');
    this.positiveInt('maxBufferedBytes');
    this.positiveInt('maxPreAttachFrames');
    this.positiveInt('maxPreAttachBytes');
    this.oneOf('onOversizeFrame', ['close', 'drop']);
    this.oneOf('onInvalidMessage', ['close', 'drop', 'hook']);
    this.oneOf('onBackpressure', ['drop', 'close']);
    this.positiveIntOrUnbounded('maxConnections', s.maxConnections);
    this.positiveIntOrUnbounded('acceptTimeoutMs', s.acceptTimeoutMs);
  }

  /**
   * `positiveInt`, widened to admit `Infinity`.
   *
   * Takes the value rather than only the field name because the base helpers
   * read the snapshot themselves and reject `Infinity` on the way — the point
   * here is exactly the value they refuse.  A no-op on `undefined`, like every
   * other helper: an unset optional always passes.
   */
  private positiveIntOrUnbounded(field: string, value: number | undefined): void {
    if (value === undefined || value === Infinity) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.fail(field, 'must be a positive integer or Infinity', value);
    }
  }
}

/**
 * The camelCase spellings this block shipped before #1405, mapped to the leaf
 * that replaced each one.  Six of the nine are caps a semi-trusted deployment
 * lowers on purpose, so an ignored old spelling would quietly restore the
 * framework default — see {@link rejectRetiredLeaves}.
 */
const RETIRED_WEBSOCKET_LEAVES: RetiredLeaves = {
  maxFrameBytes: 'max-frame-bytes',
  onOversizeFrame: 'on-oversize-frame',
  onInvalidMessage: 'on-invalid-message',
  maxBufferedBytes: 'max-buffered-bytes',
  onBackpressure: 'on-backpressure',
  maxConnections: 'max-connections',
  maxPreAttachFrames: 'max-pre-attach-frames',
  maxPreAttachBytes: 'max-pre-attach-bytes',
  acceptTimeoutMs: 'accept-timeout',
};

/**
 * Merge built-in defaults, HOCON server defaults, and per-route options.
 *
 * Leaf names are the kebab-case of the `WebsocketRouteOptions` fields with any
 * unit suffix dropped: the field carries its unit for the code side, and the
 * HOCON side does not have to repeat it because the value already does.
 */
export function resolveWebsocketPolicy(system: ActorSystem, options: WebsocketPolicyOptions): ResolvedWebsocketPolicy {
  let base = DEFAULT_WEBSOCKET_POLICY;
  const keys = ConfigKeys.http.websocket;
  const config = system.config;
  if (config.hasPath(keys.root)) {
    rejectRetiredLeaves(config, keys.root, RETIRED_WEBSOCKET_LEAVES);
    // Read HOCON leaves as-is (a bad enum flows through as a plain string and
    // is caught below by the validator as an OptionsError, not a bare Error).
    base = {
      maxFrameBytes: config.hasPath(keys.maxFrameBytes) ? config.getBytes(keys.maxFrameBytes) : base.maxFrameBytes,
      onOversizeFrame: config.hasPath(keys.onOversizeFrame)
        ? (config.getString(keys.onOversizeFrame) as OversizeFramePolicy)
        : base.onOversizeFrame,
      onInvalidMessage: config.hasPath(keys.onInvalidMessage)
        ? (config.getString(keys.onInvalidMessage) as InvalidMessagePolicy)
        : base.onInvalidMessage,
      maxBufferedBytes: config.hasPath(keys.maxBufferedBytes)
        ? config.getBytes(keys.maxBufferedBytes)
        : base.maxBufferedBytes,
      onBackpressure: config.hasPath(keys.onBackpressure)
        ? (config.getString(keys.onBackpressure) as BackpressurePolicy)
        : base.onBackpressure,
      maxConnections: config.hasPath(keys.maxConnections) ? config.getInt(keys.maxConnections) : base.maxConnections,
      maxPreAttachFrames: config.hasPath(keys.maxPreAttachFrames)
        ? config.getInt(keys.maxPreAttachFrames)
        : base.maxPreAttachFrames,
      maxPreAttachBytes: config.hasPath(keys.maxPreAttachBytes)
        ? config.getBytes(keys.maxPreAttachBytes)
        : base.maxPreAttachBytes,
      // `getDuration`, so `"10s"` reads as well as a bare millisecond count.
      acceptTimeoutMs: config.hasPath(keys.acceptTimeout)
        ? config.getDuration(keys.acceptTimeout)
        : base.acceptTimeoutMs,
    };
  }
  const resolved: ResolvedWebsocketPolicy = {
    maxFrameBytes: options.maxFrameBytes ?? base.maxFrameBytes,
    onOversizeFrame: options.onOversizeFrame ?? base.onOversizeFrame,
    onInvalidMessage: options.onInvalidMessage ?? base.onInvalidMessage,
    maxBufferedBytes: options.maxBufferedBytes ?? base.maxBufferedBytes,
    onBackpressure: options.onBackpressure ?? base.onBackpressure,
    maxConnections: options.maxConnections ?? base.maxConnections,
    maxPreAttachFrames: options.maxPreAttachFrames ?? base.maxPreAttachFrames,
    maxPreAttachBytes: options.maxPreAttachBytes ?? base.maxPreAttachBytes,
    acceptTimeoutMs: options.acceptTimeoutMs ?? base.acceptTimeoutMs,
  };
  new WebsocketPolicyOptionsValidator().validate(resolved);
  return resolved;
}
