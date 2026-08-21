import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { match } from 'ts-pattern';

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatTime, shortActorPath } from '../../core/format.js';
import type {
  ActorNode,
  ActorStartedPayload,
  ActorStoppedPayload,
  ActorTreeSnapshotPayload,
  ExplainEntriesPayload,
  ExplainStatusResult,
  MessageOutcome,
} from '../../../../src/devtools/protocol/index.js';

/** How often the ring is re-pulled while recording. */
const POLL_INTERVAL_MS = 1000;

/** Outcome → the semantic colour token that carries its meaning. */
const OUTCOME_TOKENS: Readonly<Record<MessageOutcome, string>> = {
  ok: 'dt-state--ok',
  error: 'dt-state--error',
  stashed: 'dt-state--warn',
};

/**
 * The explain-plan panel (#218) — the last messages one actor handled.
 *
 * Recording is per actor and off by default, so this panel starts by asking you
 * to pick one.  Enabling from here rather than from code is the point: "what has
 * this actor been doing?" is a question you ask while it is misbehaving, not one
 * you can plan for at build time.
 *
 * A DOM table, not a canvas — the rows are text, and the paths want to be
 * selectable and copyable.
 *
 * This panel POLLS; it does not stream.  The ring is a pull (`explain.fetch`)
 * because it is a bounded buffer the server already keeps, and pushing every
 * handled message to a UI that shows the last hundred would cost the actor
 * system far more than a request per second.  The only stream it listens to is
 * `actors`, and only to keep the chooser's list honest.
 */
@Component({
  selector: 'devtools-explain-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ExplainPanelComponent.html',
})
export class ExplainPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly actors = new Map<string, ActorNode>();
  private readonly actorPaths = signal<readonly string[]>([]);
  private readonly entries = signal<ExplainEntriesPayload | null>(null);

  readonly selected = signal<string | null>(null);
  readonly recording = signal(false);
  readonly error = signal<string | null>(null);
  readonly capacity = signal(100);

  readonly paths = this.actorPaths.asReadonly();

  /** Newest first: the reason you opened this panel is usually the last thing that happened. */
  readonly rows = computed(() => {
    const payload = this.entries();
    return payload === null ? [] : [...payload.entries].reverse();
  });

  readonly summary = computed(() => {
    if (this.selected() === null) return '';
    const payload = this.entries();
    if (payload === null || payload.entries.length === 0) return this.recording() ? 'recording…' : '';
    return `${formatCount(payload.entries.length)} of ${formatCount(payload.capacity)} kept`;
  });

  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.destroyRef.onDestroy(this.tap.listen('actors', (payload) => {
      const changed = match(payload)
        .with({ kind: 'actor-tree-snapshot' }, (p) => this.onActorTreeSnapshot(p))
        .with({ kind: 'actor-started' }, (p) => this.onActorStarted(p))
        .with({ kind: 'actor-stopped' }, (p) => this.onActorStopped(p))
        .otherwise(() => this.onOtherActorPayload());
      if (changed) this.refreshChooser();
    }));

    this.destroyRef.onDestroy(() => {
      this.stopPolling();
      // Leave the actor as we found it rather than recording forever.
      const path = this.selected();
      if (this.recording() && path !== null) {
        void this.tap.request('explain.disable', { path }).catch(() => {
          /* the socket may already be gone; the server cleans up on detach */
        });
      }
    });
  }

  outcomeToken(outcome: MessageOutcome): string { return OUTCOME_TOKENS[outcome]; }
  formatAt(atMs: number): string { return formatTime(atMs); }
  senderOf(path: string | null): string { return path === null ? '—' : shortActorPath(path); }

  /** Handling times are usually sub-millisecond, so show enough digits. */
  milliseconds(value: number): string {
    if (value >= 100) return `${value.toFixed(0)} ms`;
    if (value >= 1) return `${value.toFixed(2)} ms`;
    return `${(value * 1000).toFixed(0)} µs`;
  }

  onSelect(event: Event): void {
    const path = (event.target as HTMLSelectElement).value;
    this.selected.set(path === '' ? null : path);
    this.entries.set(null);
    this.recording.set(false);
    this.stopPolling();
  }

  onCapacity(event: Event): void {
    const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
    this.capacity.set(Number.isInteger(parsed) && parsed > 0 ? parsed : 0);
  }

  async onToggleRecording(): Promise<void> {
    const path = this.selected();
    if (path === null) return;
    this.error.set(null);
    try {
      if (this.recording()) {
        await this.tap.request<ExplainStatusResult>('explain.disable', { path });
        this.recording.set(false);
        this.stopPolling();
        return;
      }
      const capacity = this.capacity();
      await this.tap.request<ExplainStatusResult>('explain.enable', {
        path,
        ...(capacity > 0 ? { capacity } : {}),
      });
      this.recording.set(true);
      this.startPolling();
      await this.refresh();
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
      this.recording.set(false);
      this.stopPolling();
    }
  }

  private async refresh(): Promise<void> {
    const path = this.selected();
    if (path === null) return;
    try {
      this.entries.set(await this.tap.request<ExplainEntriesPayload>('explain.fetch', { path }));
      this.error.set(null);
    } catch (cause) {
      // The actor may simply have stopped while we were watching.
      this.error.set(cause instanceof Error ? cause.message : String(cause));
      this.recording.set(false);
      this.stopPolling();
    }
  }

  private startPolling(): void {
    if (this.poll !== null) return;
    this.poll = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.poll === null) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  private refreshChooser(): void {
    this.actorPaths.set([...this.actors.values()]
      .filter((actor) => !actor.internal)
      .map((actor) => actor.path)
      .sort((a, b) => a.localeCompare(b)));
  }

  private onActorTreeSnapshot(payload: ActorTreeSnapshotPayload): boolean {
    this.actors.clear();
    for (const actor of payload.actors) this.actors.set(actor.path, actor);
    return true;
  }

  private onActorStarted(payload: ActorStartedPayload): boolean {
    this.actors.set(payload.actor.path, payload.actor);
    return true;
  }

  private onActorStopped(payload: ActorStoppedPayload): boolean {
    this.actors.delete(payload.path);
    return true;
  }

  /** Only the chooser's actor list matters here — other frames change nothing. */
  private onOtherActorPayload(): boolean {
    return false;
  }
}

/** The registry loads this module and reads this export. */
export const panelComponent = ExplainPanelComponent;
