/**
 * What "pause" means, per stream, and the bounded queue that holds a
 * paused stream's frames (#1349).
 *
 * Framework-free on purpose, like `history.ts` beside it: the policy table
 * and the queue arithmetic are exactly the parts worth testing under `bun
 * test`, and neither needs Angular or a DOM.  The service that owns the
 * paused *state* is `app/TimeControlService.ts`; this file only knows what
 * to do with a frame once something else has decided time is stopped.
 */
import type {
  DevToolsStreamId,
  DevToolsStreamPayload,
} from '../../../src/devtools/protocol/index.js';

/**
 * How much one paused stream may hold before the oldest frame is dropped.
 *
 * Generous rather than tight: a pause is measured in the tens of seconds a
 * person spends reading, and the panels downstream cap themselves anyway
 * (`BUS_EVENT_TAIL_ROWS`, the tracing ring).  The cap exists so that walking
 * away from a paused tab for an hour costs bounded memory, not so that an
 * ordinary pause ever reaches it.
 */
export const PAUSE_BUFFER_FRAMES = 2_000;

/**
 * What happens to a stream's frames while time is stopped.
 *
 * - `buffer` — append-shaped: the frames *are* the content, and there is no
 *   snapshot to recover them from.  `EventStreamTap.snapshot()` deliberately
 *   returns nothing ("a tail has no past"), so anything dropped here is gone.
 * - `resync` — state-shaped: each snapshot replaces the panel's state whole
 *   (`ActorTreeModel.reset`, `onClusterSnapshot`), so discarding the deltas
 *   and asking for a fresh snapshot on resume is both exact and cheaper than
 *   replaying them.  It is also the path `deliverStreamEvent` already takes
 *   on a sequence gap, rather than a second recovery mechanism.
 */
export type PauseStreamPolicy = 'buffer' | 'resync';

/**
 * The policy per stream.
 *
 * A total `Record` over `DevToolsStreamId` rather than a lookup with a
 * default: adding a stream to the protocol should fail to compile here and
 * force the decision, not silently inherit whichever behaviour the fallback
 * happened to be.
 */
export const PAUSE_POLICIES: Readonly<Record<DevToolsStreamId, PauseStreamPolicy>> = {
  stats: 'resync',
  actors: 'resync',
  cluster: 'resync',
  mailboxes: 'resync',
  spans: 'buffer',
  explain: 'buffer',
  profiler: 'buffer',
  events: 'buffer',
};

/**
 * A paused stream's frames, oldest first.
 *
 * Drops the oldest on overflow rather than refusing the newest: a pause that
 * outlasts the cap is one where the recent past is the interesting part.  The
 * dropped count is kept and surfaced — a silently shortened tail would read
 * as a quiet system, which is a different answer.
 */
export class PauseBuffer {
  private frames: DevToolsStreamPayload[] = [];
  private droppedFrames = 0;

  constructor(private readonly capacity: number = PAUSE_BUFFER_FRAMES) {}

  push(payload: DevToolsStreamPayload): void {
    this.frames.push(payload);
    if (this.frames.length <= this.capacity) return;
    this.frames.splice(0, this.frames.length - this.capacity);
    this.droppedFrames++;
  }

  /** Everything held, oldest first, leaving the buffer empty. */
  drain(): readonly DevToolsStreamPayload[] {
    const held = this.frames;
    this.frames = [];
    return held;
  }

  /** Forget everything, including the dropped tally. */
  clear(): void {
    this.frames = [];
    this.droppedFrames = 0;
  }

  get size(): number {
    return this.frames.length;
  }

  /** How many frames the cap threw away.  Survives `drain`, not `clear`. */
  get dropped(): number {
    return this.droppedFrames;
  }
}

/**
 * The wall clock, stopped.
 *
 * Every "how long ago" reading in the UI is `now - then`, so freezing `now`
 * is what makes a paused view actually hold still — otherwise the actors
 * panel ages its tombstones out from under the reader while they are looking
 * at them, which is the one thing pausing was for.
 */
export function frozenNow(pausedAtMs: number | null): number {
  return pausedAtMs ?? Date.now();
}
