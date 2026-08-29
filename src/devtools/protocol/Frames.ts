/**
 * The DevTools tap envelope — the frames that carry every panel's data
 * over one multiplexed WebSocket (#445).
 *
 * One socket serves all panels: a browser tab opens a single connection
 * and subscribes to the streams the visible panel needs, so an idle tab
 * costs the actor system nothing while switching panels costs no
 * reconnect.  Request/response rides the same socket for the pull-shaped
 * operations (journal paging, profiler control) that would not make
 * sense as a stream.
 *
 * Frames are `kind`-tagged plain objects, matching the WebSocket message
 * convention elsewhere in the framework.  Inbound frames arrive from a
 * browser and are therefore UNTRUSTED — never consume them without
 * {@link decodeClientFrame}, which is the only thing standing between a
 * hostile page and the tap dispatcher.
 */
import { DEVTOOLS_PROTOCOL_VERSION } from './Version.js';
import type { ActorStreamPayload, MailboxStreamPayload } from './ActorStreamFrames.js';
import type { ClusterStreamPayload } from './ClusterStreamFrames.js';
import type { BusEventStreamPayload } from './EventStreamFrames.js';
import type { ExplainStreamPayload } from './ExplainFrames.js';
import type { ProfilerStreamPayload } from './ProfilerFrames.js';
import type { StatsStreamPayload } from './StatsFrames.js';
import type { TracingStreamPayload } from './TracingStreamFrames.js';

/* ------------------------------ vocabulary ------------------------------ */

/** Push channels a client can subscribe to. */
export type DevToolsStreamId =
  | 'stats'
  | 'actors'
  | 'cluster'
  | 'mailboxes'
  | 'spans'
  | 'explain'
  | 'profiler'
  | 'events';

/** Every stream id, for validation and iteration. */
export const DEVTOOLS_STREAM_IDS: ReadonlyArray<DevToolsStreamId> = [
  'stats',
  'actors',
  'cluster',
  'mailboxes',
  'spans',
  'explain',
  'profiler',
  'events',
];

/** Pull operations, namespaced by the panel that owns them. */
export type DevToolsRequestMethod =
  | 'explain.enable'
  | 'explain.disable'
  | 'explain.fetch'
  | 'journal.ids'
  | 'journal.read'
  | 'replay.capabilities'
  | 'replay.state'
  | 'replay.diff'
  | 'stats.history'
  | 'profiler.capabilities'
  | 'profiler.start'
  | 'profiler.stop'
  | 'tracing.buffer'
  | 'deadletters.list'
  | 'pubsub.topics'
  | 'config.resolved'
  | 'actors.send';

/** Every request method, for validation and iteration. */
export const DEVTOOLS_REQUEST_METHODS: ReadonlyArray<DevToolsRequestMethod> = [
  'explain.enable',
  'explain.disable',
  'explain.fetch',
  'journal.ids',
  'journal.read',
  'replay.capabilities',
  'replay.state',
  'replay.diff',
  'stats.history',
  'profiler.capabilities',
  'profiler.start',
  'profiler.stop',
  'tracing.buffer',
  'deadletters.list',
  'pubsub.topics',
  'config.resolved',
  'actors.send',
];

/** Panels of the UI shell — the cards on the dashboard. */
export type DevToolsPanelId =
  | 'dashboard'
  | 'actors'
  | 'cluster'
  | 'tracing'
  | 'explain'
  | 'time-travel'
  | 'profiler'
  | 'dead-letters'
  | 'event-stream'
  | 'config'
  | 'send';

/**
 * Whether a panel can be used right now.  `'disabled'` means the
 * operator switched it off; `'unavailable'` means the system cannot
 * support it (no cluster, no journal, the tracer slot is taken) and
 * carries a `reason` the dashboard card shows instead of a link.
 */
export type DevToolsPanelStatus = 'active' | 'unavailable' | 'disabled';

/** One panel as advertised in the handshake. */
export type DevToolsPanelDescriptor = {
  readonly id: DevToolsPanelId;
  readonly status: DevToolsPanelStatus;
  /** Human-readable explanation, set when the status is not `'active'`. */
  readonly reason?: string;
};

/** Why the server rejected a frame. */
export type DevToolsErrorCode =
  | 'version-mismatch'
  | 'malformed-frame'
  | 'unknown-stream'
  | 'unknown-method'
  | 'unavailable'
  | 'bad-parameters'
  | 'internal';

/** WebSocket close code for a protocol-version mismatch. */
export const DEVTOOLS_CLOSE_VERSION_MISMATCH = 4400;

/* --------------------------- client → server ---------------------------- */

/** Opening frame; must be the first one a client sends. */
export type HelloFrame = {
  readonly kind: 'hello';
  readonly protocolVersion: number;
  /** Free-form client identification, for the server log. */
  readonly client?: string;
};

/** Start receiving `event` frames for one stream. */
export type SubscribeFrame = {
  readonly kind: 'subscribe';
  readonly stream: DevToolsStreamId;
  /** Stream-specific options, e.g. the actor path for `explain`. */
  readonly parameters?: unknown;
};

/** Stop receiving `event` frames for one stream. */
export type UnsubscribeFrame = {
  readonly kind: 'unsubscribe';
  readonly stream: DevToolsStreamId;
};

/** Invoke a pull operation; answered by exactly one `response` or `error`. */
export type RequestFrame = {
  readonly kind: 'request';
  /** Client-chosen correlation id, echoed back. */
  readonly requestId: number;
  readonly method: DevToolsRequestMethod;
  readonly parameters?: unknown;
};

/** Anything a client may send. */
export type DevToolsClientFrame = HelloFrame | SubscribeFrame | UnsubscribeFrame | RequestFrame;

/* --------------------------- server → client ---------------------------- */

/** Answer to `hello` — the client renders its shell from this. */
export type WelcomeFrame = {
  readonly kind: 'welcome';
  readonly protocolVersion: number;
  /** `package.json` version of the running framework. */
  readonly serverVersion: string;
  readonly systemName: string;
  /**
   * When the `ActorSystem` was created — not when this socket connected.
   * A client may reconnect any number of times; the system's age is the
   * same each time it asks.
   */
  readonly startedAtMs: number;
  /** Streams this server will actually serve. */
  readonly streams: ReadonlyArray<DevToolsStreamId>;
  /** Panel availability, driving the dashboard cards. */
  readonly panels: ReadonlyArray<DevToolsPanelDescriptor>;
};

/** One stream event. */
export type EventFrame = {
  readonly kind: 'event';
  readonly stream: DevToolsStreamId;
  /**
   * Per-stream counter starting at 1.  A gap tells the UI that frames
   * were dropped under backpressure, so it can re-subscribe for a fresh
   * snapshot instead of rendering an inconsistent tree.
   */
  readonly sequenceNumber: number;
  readonly payload: DevToolsStreamPayload;
};

/** Successful answer to a `request`. */
export type ResponseFrame = {
  readonly kind: 'response';
  readonly requestId: number;
  readonly result: unknown;
};

/** Rejection — of a request (with `requestId`) or of the connection. */
export type ErrorFrame = {
  readonly kind: 'error';
  readonly requestId?: number;
  readonly code: DevToolsErrorCode;
  readonly message: string;
};

/** Anything the server may send. */
export type DevToolsServerFrame = WelcomeFrame | EventFrame | ResponseFrame | ErrorFrame;

/** Union of every stream payload, discriminated by its own `kind`. */
export type DevToolsStreamPayload =
  | StatsStreamPayload
  | ActorStreamPayload
  | ClusterStreamPayload
  | MailboxStreamPayload
  | TracingStreamPayload
  | ExplainStreamPayload
  | ProfilerStreamPayload
  | BusEventStreamPayload;

/* ------------------------------ factories ------------------------------- */

/** Build the opening frame — used by the UI client. */
export function helloFrame(client?: string): HelloFrame {
  return client === undefined
    ? { kind: 'hello', protocolVersion: DEVTOOLS_PROTOCOL_VERSION }
    : { kind: 'hello', protocolVersion: DEVTOOLS_PROTOCOL_VERSION, client };
}

/** @internal */
export function welcomeFrame(welcome: Omit<WelcomeFrame, 'kind' | 'protocolVersion'>): WelcomeFrame {
  return { kind: 'welcome', protocolVersion: DEVTOOLS_PROTOCOL_VERSION, ...welcome };
}

/** @internal */
export function eventFrame(
  stream: DevToolsStreamId,
  sequenceNumber: number,
  payload: DevToolsStreamPayload,
): EventFrame {
  return { kind: 'event', stream, sequenceNumber, payload };
}

/** @internal */
export function responseFrame(requestId: number, result: unknown): ResponseFrame {
  return { kind: 'response', requestId, result };
}

/** @internal */
export function errorFrame(
  code: DevToolsErrorCode,
  message: string,
  requestId?: number,
): ErrorFrame {
  return requestId === undefined
    ? { kind: 'error', code, message }
    : { kind: 'error', code, message, requestId };
}

/* ------------------------------- decoding ------------------------------- */

/**
 * Validate one decoded JSON value as a client frame.
 *
 * Returns `null` for anything that is not a well-formed frame — the
 * caller answers with a `malformed-frame` error rather than trusting a
 * partially-shaped object.  Unknown `kind`s are rejected here too: the
 * "ignore what you don't know" half of the compatibility contract
 * applies to CLIENTS reading server frames, not to the server, which
 * has no reason to accept frames from a client newer than itself.
 */
export function decodeClientFrame(raw: unknown): DevToolsClientFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  switch (frame['kind']) {
    case 'hello':
      return typeof frame['protocolVersion'] === 'number'
        && (frame['client'] === undefined || typeof frame['client'] === 'string')
        ? (frame as unknown as HelloFrame)
        : null;
    case 'subscribe':
      return isStreamId(frame['stream']) ? (frame as unknown as SubscribeFrame) : null;
    case 'unsubscribe':
      return isStreamId(frame['stream']) ? (frame as unknown as UnsubscribeFrame) : null;
    case 'request':
      return Number.isInteger(frame['requestId']) && isRequestMethod(frame['method'])
        ? (frame as unknown as RequestFrame)
        : null;
    default:
      return null;
  }
}

/** True when `value` is a known stream id. */
export function isStreamId(value: unknown): value is DevToolsStreamId {
  return typeof value === 'string'
    && DEVTOOLS_STREAM_IDS.includes(value as DevToolsStreamId);
}

/** True when `value` is a known request method. */
export function isRequestMethod(value: unknown): value is DevToolsRequestMethod {
  return typeof value === 'string'
    && DEVTOOLS_REQUEST_METHODS.includes(value as DevToolsRequestMethod);
}
