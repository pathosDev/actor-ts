/**
 * The actor profiler (#226) — where does the system spend its time?
 *
 * Two modes, because they answer different questions:
 *
 *   - **wallclock** aggregates the framework's own per-message timings
 *     into an actor-path flame graph: "which actors, handling which
 *     messages, account for the time?".  Always available, and the
 *     actor-shaped answer V8's profiler cannot give.
 *   - **cpu** passes through the host V8 CPU profile: "which JS frames
 *     burn the CPU?".  Needs an inspector, which not every runtime
 *     provides — reported as unavailable rather than faked where it is
 *     missing.
 *
 * One session at a time.  Two overlapping profiles would each see part
 * of the picture and neither would be right.
 */
import { MAXIMUM_DURATION_MS, PROGRESS_INTERVAL_MS } from '../Constants.js';
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import type { DispatchObservation, DispatchObserver } from '../../internal/Instrumentation.js';
import { detectRuntime } from '../../runtime/detect.js';
import {
  profilerCompletedPayload,
  profilerProgressPayload,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type ProfilerCapabilitiesResult,
  type ProfilerMode,
  type ProfilerModeCapability,
  type ProfilerStartParameters,
  type ProfilerStartResult,
  type ProfilerStopResult,
} from '../protocol/index.js';
import type { DevToolsServer, DevToolsTap } from '../DevToolsServer.js';

/** One aggregated `(actor, message)` pair. */
type Bucket = {
  readonly actorPath: string;
  readonly className: string;
  readonly messageType: string;
  count: number;
  totalMs: number;
  errors: number;
};

/** A running wallclock session. */
type WallclockSession = {
  readonly mode: 'wallclock';
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly buckets: Map<string, Bucket>;
  sampleCount: number;
  /** The observer we installed, so `stop` can put back what was there. */
  readonly previousObserver: DispatchObserver | null;
  autoStop: Cancellable | null;
};

/** A running CPU session; the inspector holds the samples. */
interface CpuSession {
  readonly mode: 'cpu';
  readonly sessionId: string;
  readonly startedAtMs: number;
  stop(): Promise<unknown>;
  autoStop: Cancellable | null;
}

type Session = WallclockSession | CpuSession;

export class ProfilerTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'profiler';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private session: Session | null = null;
  private progressTicker: Cancellable | null = null;
  private sessionCounter = 0;

  constructor(private readonly system: ActorSystem) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
  }

  uninstall(): void {
    // A profiler left running because a browser tab closed would keep
    // an observer on the hot path forever.
    void this.abort();
    this.emit = null;
  }

  /** Nothing to replay: a profile is produced by a run, not held. */
  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [];
  }

  /** Register the control methods on `server`. */
  installMethods(server: DevToolsServer): void {
    server.registerMethod('profiler.capabilities', () => this.onCapabilities());
    server.registerMethod('profiler.start', (p) => this.onStart(p));
    server.registerMethod('profiler.stop', () => this.onStop());
  }

  /**
   * Which modes this host can actually run.
   *
   * Asked before the panel offers them, so an unsupported mode is greyed
   * out with its reason instead of throwing a runtime's internal error
   * message at whoever pressed Start.
   */
  private async onCapabilities(): Promise<ProfilerCapabilitiesResult> {
    return {
      modes: [
        { mode: 'wallclock', available: true },
        await cpuCapability(),
      ],
    };
  }

  private async onStart(parameters: unknown): Promise<ProfilerStartResult> {
    if (this.session !== null) {
      throw new Error('a profiling session is already running — stop it first');
    }
    const request = (parameters ?? {}) as ProfilerStartParameters;
    const mode: ProfilerMode = request.mode ?? 'wallclock';
    const durationMs = request.durationMs;
    if (durationMs !== undefined
      && (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAXIMUM_DURATION_MS)) {
      throw new Error(`\`durationMs\` must be between 1 and ${MAXIMUM_DURATION_MS}`);
    }

    const sessionId = `profile-${++this.sessionCounter}`;
    const startedAtMs = Date.now();
    this.session = mode === 'cpu'
      ? await this.startCpu(sessionId, startedAtMs)
      : this.startWallclock(sessionId, startedAtMs);

    if (durationMs !== undefined) {
      this.session.autoStop = this.system.scheduler.scheduleOnceFunction(durationMs, () => {
        void this.finish().then((result) => {
          if (result !== null) this.emit?.(profilerCompletedPayload(Date.now(), result.sessionId));
        });
      });
    }
    this.startProgress();
    return { sessionId, mode, startedAtMs };
  }

  private startWallclock(sessionId: string, startedAtMs: number): WallclockSession {
    const session: WallclockSession = {
      mode: 'wallclock',
      sessionId,
      startedAtMs,
      buckets: new Map(),
      sampleCount: 0,
      previousObserver: this.system._dispatchObserver,
      autoStop: null,
    };
    this.system._setDispatchObserver({
      onMessageProcessed: (observation) => record(session, observation),
    });
    return session;
  }

  /**
   * Start a V8 CPU profile through `node:inspector`.
   *
   * Feature-detected rather than assumed: the module is absent or
   * incomplete on some runtimes, and a profiler that throws on start is
   * worse than one that says it cannot run here.
   */
  private async startCpu(sessionId: string, startedAtMs: number): Promise<CpuSession> {
    const inspectorSession = await openInspectorSession();
    try {
      inspectorSession.connect();
    } catch (cause) {
      throw new Error(`could not connect the inspector: ${(cause as Error).message}`);
    }

    const post = (method: string): Promise<unknown> => new Promise((resolve, reject) => {
      inspectorSession.post(method, (error: Error | null, result?: unknown) => {
        if (error) reject(error);
        else resolve(result);
      });
    });

    await post('Profiler.enable');
    await post('Profiler.start');
    return {
      mode: 'cpu',
      sessionId,
      startedAtMs,
      stop: async () => {
        const result = await post('Profiler.stop') as { profile?: unknown };
        inspectorSession.disconnect();
        return result.profile ?? null;
      },
      autoStop: null,
    };
  }

  private async onStop(): Promise<ProfilerStopResult> {
    const result = await this.finish();
    if (result === null) throw new Error('no profiling session is running');
    return result;
  }

  /** End the session and build its report, or `null` if none was running. */
  private async finish(): Promise<ProfilerStopResult | null> {
    const session = this.session;
    if (session === null) return null;
    this.session = null;
    session.autoStop?.cancel();
    this.stopProgress();
    const stoppedAtMs = Date.now();

    if (session.mode === 'cpu') {
      return {
        sessionId: session.sessionId,
        mode: 'cpu',
        startedAtMs: session.startedAtMs,
        stoppedAtMs,
        format: 'cpuprofile',
        sampleCount: 0,
        profile: await session.stop(),
      };
    }

    // Put back whatever was observing before us, rather than clearing.
    this.system._setDispatchObserver(session.previousObserver);
    return {
      sessionId: session.sessionId,
      mode: 'wallclock',
      startedAtMs: session.startedAtMs,
      stoppedAtMs,
      format: 'speedscope',
      sampleCount: session.sampleCount,
      profile: toSpeedscope(session, stoppedAtMs),
    };
  }

  /** Stop without reporting — used when the tap goes away. */
  private async abort(): Promise<void> {
    if (this.session === null) return;
    try {
      await this.finish();
    } catch {
      /* tearing down; a failed stop must not block uninstall */
    }
  }

  private startProgress(): void {
    if (this.progressTicker !== null) return;
    this.progressTicker = this.system.scheduler.scheduleAtFixedRateFunction(
      PROGRESS_INTERVAL_MS,
      PROGRESS_INTERVAL_MS,
      () => {
        const session = this.session;
        if (session === null) return;
        this.emit?.(profilerProgressPayload(
          Date.now(),
          session.sessionId,
          session.mode === 'wallclock' ? session.sampleCount : 0,
          Date.now() - session.startedAtMs,
        ));
      },
    );
  }

  private stopProgress(): void {
    this.progressTicker?.cancel();
    this.progressTicker = null;
  }
}

/** Fold one observation into its bucket.  Called on the hot path. */
function record(session: WallclockSession, observation: DispatchObservation): void {
  const key = `${observation.actorPath}\0${observation.messageType}`;
  let bucket = session.buckets.get(key);
  if (bucket === undefined) {
    bucket = {
      actorPath: observation.actorPath,
      className: observation.className,
      messageType: observation.messageType,
      count: 0,
      totalMs: 0,
      errors: 0,
    };
    session.buckets.set(key, bucket);
  }
  bucket.count++;
  bucket.totalMs += observation.handleTimeMs;
  if (observation.outcome === 'error') bucket.errors++;
  session.sampleCount++;
}

/**
 * Render the buckets as a speedscope document.
 *
 * Each bucket becomes one stack — the actor's path segments, then the
 * message type — weighted by the time spent in it.  The result opens in
 * speedscope.app unchanged, and the panel renders the same tree itself.
 */
function toSpeedscope(session: WallclockSession, stoppedAtMs: number): unknown {
  const frameIndex = new Map<string, number>();
  const frames: Array<{ name: string }> = [];
  const indexOf = (name: string): number => {
    const existing = frameIndex.get(name);
    if (existing !== undefined) return existing;
    frames.push({ name });
    frameIndex.set(name, frames.length - 1);
    return frames.length - 1;
  };

  const samples: number[][] = [];
  const weights: number[] = [];
  let total = 0;
  for (const bucket of session.buckets.values()) {
    const segments = bucket.actorPath.replace(/^actor-ts:\/\/[^/]*/, '').split('/')
      .filter((segment) => segment.length > 0);
    const stack = [...segments, `${bucket.messageType} (${bucket.className})`].map(indexOf);
    samples.push(stack);
    weights.push(bucket.totalMs);
    total += bucket.totalMs;
  }

  return {
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    name: `actor-ts ${session.sessionId}`,
    activeProfileIndex: 0,
    exporter: 'actor-ts devtools',
    shared: { frames },
    profiles: [{
      type: 'sampled',
      name: `wallclock ${new Date(session.startedAtMs).toISOString()}`,
      unit: 'milliseconds',
      startValue: 0,
      endValue: total,
      samples,
      weights,
    }],
    // Not part of the speedscope schema, but harmless there and exactly
    // what the panel needs to render counts and error rates.
    actorTs: {
      startedAtMs: session.startedAtMs,
      stoppedAtMs,
      buckets: [...session.buckets.values()].map((bucket) => ({
        actorPath: bucket.actorPath,
        className: bucket.className,
        messageType: bucket.messageType,
        count: bucket.count,
        totalMs: bucket.totalMs,
        errors: bucket.errors,
      })),
    },
  };
}

/* --------------------------- inspector probing --------------------------- */

/** Cached, because the answer cannot change while the process runs. */
let cpuCapabilityCache: ProfilerModeCapability | null = null;

/**
 * Can this host produce a V8 CPU profile?
 *
 * Importing `node:inspector` is not the test.  On Bun the import
 * **succeeds** and even exports a `Session` symbol; the failure comes
 * from the constructor, which throws `NotImplementedError`.  So the
 * probe constructs one and throws it away.
 */
async function cpuCapability(): Promise<ProfilerModeCapability> {
  if (cpuCapabilityCache !== null) return cpuCapabilityCache;
  try {
    const inspector = await import('node:inspector');
    new inspector.Session();
    cpuCapabilityCache = { mode: 'cpu', available: true };
  } catch (cause) {
    cpuCapabilityCache = { mode: 'cpu', available: false, reason: refusal(cause) };
  }
  return cpuCapabilityCache;
}

/**
 * A reason short enough to sit in a dropdown label.
 *
 * Runtimes tend to append links and advice — Bun's message carries a
 * GitHub issue URL — and only the first sentence is the answer.
 */
function refusal(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.trim() : '';
  const sentence = message.split('. ')[0]?.trim();
  return sentence === undefined || sentence.length === 0
    ? `node:inspector is unavailable on ${detectRuntime()}`
    : sentence.replace(/\.$/, '');
}

/** An inspector session, or a clear refusal naming the runtime. */
async function openInspectorSession(): Promise<import('node:inspector').Session> {
  const capability = await cpuCapability();
  if (!capability.available) {
    throw new Error(`CPU profiling is not available here: ${capability.reason ?? 'no inspector'}`);
  }
  const inspector = await import('node:inspector');
  return new inspector.Session();
}
