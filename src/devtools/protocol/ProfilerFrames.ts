/**
 * Control + result shapes of the actor profiler (#226).
 *
 * A profiling run is a request/response pair (`profiler.start` →
 * `profiler.stop`) with progress pushed on the `profiler` stream in
 * between, so a long run shows a live sample count instead of an
 * unresponsive button.
 *
 * Two modes, because they answer different questions:
 *
 *   - `'wallclock'` aggregates the framework's own per-message timings
 *     into an actor-path flame graph ("which actors spend the time?").
 *     Always available.
 *   - `'cpu'` passes through the host V8 CPU profile ("which JS frames
 *     spend the time?").  Requires an inspector, which not every
 *     runtime provides — the panel reports it as unavailable there.
 */

/** What a profiling session measures. */
export type ProfilerMode = 'wallclock' | 'cpu';

/** Output format of a finished session. */
export type ProfilerFormat = 'speedscope' | 'cpuprofile';

/** One mode, and whether this host can actually run it. */
export interface ProfilerModeCapability {
  readonly mode: ProfilerMode;
  readonly available: boolean;
  /** Why not, when `available` is false — shown next to the option. */
  readonly reason?: string;
}

/**
 * Result of `profiler.capabilities`.
 *
 * Asked before the panel offers a mode, so an unsupported one is greyed
 * out with its reason rather than failing when Start is pressed.
 */
export interface ProfilerCapabilitiesResult {
  readonly modes: ReadonlyArray<ProfilerModeCapability>;
}

/** Parameters of `profiler.start`. */
export interface ProfilerStartParameters {
  /** Default `'wallclock'`. */
  readonly mode?: ProfilerMode;
  /** Auto-stop after this long; omit to stop manually. */
  readonly durationMs?: number;
}

/** Result of `profiler.start`. */
export interface ProfilerStartResult {
  readonly sessionId: string;
  readonly mode: ProfilerMode;
  readonly startedAtMs: number;
}

/** Result of `profiler.stop`. */
export interface ProfilerStopResult {
  readonly sessionId: string;
  readonly mode: ProfilerMode;
  readonly startedAtMs: number;
  readonly stoppedAtMs: number;
  readonly format: ProfilerFormat;
  readonly sampleCount: number;
  /** Profile document in `format` — rendered by the panel, opaque here. */
  readonly profile: unknown;
}

/** Live progress of a running session. */
export interface ProfilerProgressPayload {
  readonly kind: 'profiler-progress';
  readonly atMs: number;
  readonly sessionId: string;
  readonly sampleCount: number;
  readonly elapsedMs: number;
}

/** A session ended on its own (`durationMs` elapsed). */
export interface ProfilerCompletedPayload {
  readonly kind: 'profiler-completed';
  readonly atMs: number;
  readonly sessionId: string;
}

/** Payloads carried by the `profiler` stream. */
export type ProfilerStreamPayload = ProfilerProgressPayload | ProfilerCompletedPayload;

/** @internal */
export function profilerProgressPayload(
  atMs: number,
  sessionId: string,
  sampleCount: number,
  elapsedMs: number,
): ProfilerProgressPayload {
  return { kind: 'profiler-progress', atMs, sessionId, sampleCount, elapsedMs };
}

/** @internal */
export function profilerCompletedPayload(atMs: number, sessionId: string): ProfilerCompletedPayload {
  return { kind: 'profiler-completed', atMs, sessionId };
}
