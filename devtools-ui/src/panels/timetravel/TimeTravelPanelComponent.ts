import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatTime } from '../../core/format.js';
import { changedOnly, diffStates, type DiffEntry } from './stateDiff.js';
import type {
  JournalEventView,
  JournalIdentifierInfo,
  JournalIdentifiersResult,
  JournalReadResult,
  ReplayCapabilitiesResult,
  ReplayDiffResult,
} from '../../../../src/devtools/protocol/index.js';

/** Events pulled per page. */
const PAGE_SIZE = 200;

/**
 * The time-travel panel (#201) — browse a journal, reconstruct state.
 *
 * Strictly read-only.  Pick a persistence id, drag the slider to a sequence
 * number, see the state as it was and what the event at that point changed.
 *
 * Where no fold is known the panel degrades honestly: the event log still
 * works, and the state pane says why it cannot show a state.  Turning events
 * back into state needs `onEvent`, which lives in the user's actor class and
 * cannot be recovered from stored data.
 */
@Component({
  selector: 'devtools-time-travel-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './TimeTravelPanelComponent.html',
})
export class TimeTravelPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);

  readonly identifiers = signal<readonly JournalIdentifierInfo[]>([]);
  readonly events = signal<readonly JournalEventView[]>([]);
  readonly capability = signal<ReplayCapabilitiesResult | null>(null);
  readonly diff = signal<ReplayDiffResult | null>(null);
  readonly selected = signal<string | null>(null);
  readonly position = signal(0);
  readonly highest = signal(0);
  readonly error = signal<string | null>(null);
  readonly showUnchanged = signal(false);

  /** Answers that arrive after the panel is gone must not be applied. */
  private disposed = false;

  readonly noFold = computed(() => {
    const caps = this.capability();
    return caps !== null && caps.capability !== 'state';
  });

  readonly summary = computed(() => (this.selected() === null
    ? `${formatCount(this.identifiers().length)} persistence ids`
    : `${formatCount(this.events().length)} events loaded`));

  private readonly diffEntries = computed<readonly DiffEntry[]>(() => {
    const current = this.diff();
    return current === null ? [] : diffStates(current.from.state, current.to.state);
  });

  readonly visibleDiff = computed(() => (this.showUnchanged()
    ? this.diffEntries()
    : changedOnly(this.diffEntries())));

  readonly fullState = computed(() => JSON.stringify(this.diff()?.to.state, null, 2));

  constructor() {
    this.destroyRef.onDestroy(() => { this.disposed = true; });
    void this.loadIdentifiers();
  }

  count(value: number): string { return formatCount(value); }
  at(timestampMs: number): string { return formatTime(timestampMs); }

  renderValue(value: unknown): string {
    if (value === undefined) return '—';
    if (typeof value === 'string') return value;
    return JSON.stringify(value) ?? String(value);
  }

  /** One-line preview of an event payload for the timeline. */
  summarise(event: JournalEventView): string {
    const payload = event.payload;
    if (payload !== null && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      // `kind` is the project-wide discriminant, so lead with it.
      const kind = typeof record['kind'] === 'string' ? record['kind'] : null;
      const rendered = JSON.stringify(payload);
      const body = rendered.length > 80 ? `${rendered.slice(0, 80)}…` : rendered;
      return kind === null ? body : `${kind} ${body}`;
    }
    return String(payload);
  }

  onSelect(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.selected.set(value === '' ? null : value);
    void this.loadSelected();
  }

  onSlide(event: Event): void {
    this.position.set(Number((event.target as HTMLInputElement).value));
    void this.loadState();
  }

  onPickEvent(sequenceNumber: number): void {
    this.position.set(sequenceNumber);
    void this.loadState();
  }

  onToggleUnchanged(event: Event): void {
    this.showUnchanged.set((event.target as HTMLInputElement).checked);
  }

  private async loadIdentifiers(): Promise<void> {
    try {
      const result = await this.tap.request<JournalIdentifiersResult>('journal.ids');
      if (this.disposed) return;
      this.identifiers.set(result.identifiers);
      this.error.set(null);
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private async loadSelected(): Promise<void> {
    const persistenceId = this.selected();
    this.events.set([]);
    this.diff.set(null);
    this.capability.set(null);
    this.position.set(0);
    this.highest.set(0);
    if (persistenceId === null) return;
    try {
      const [page, caps] = await Promise.all([
        this.tap.request<JournalReadResult>('journal.read', {
          persistenceId, fromSequenceNumber: 1, limit: PAGE_SIZE,
        }),
        this.tap.request<ReplayCapabilitiesResult>('replay.capabilities', { persistenceId }),
      ]);
      if (this.disposed) return;
      this.events.set(page.events);
      this.capability.set(caps);
      this.highest.set(page.highestSequenceNumber);
      this.position.set(page.highestSequenceNumber);
      this.error.set(null);
      await this.loadState();
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * Fetch the state at the slider position and at the step before it, so the
   * panel can show what the event at that point actually did — which is the
   * question, more often than the absolute state.
   */
  private async loadState(): Promise<void> {
    const persistenceId = this.selected();
    if (persistenceId === null || this.capability()?.capability !== 'state') return;
    const to = this.position();
    try {
      const result = await this.tap.request<ReplayDiffResult>('replay.diff', {
        persistenceId,
        fromSequenceNumber: Math.max(to - 1, 0),
        toSequenceNumber: to,
      });
      if (this.disposed) return;
      // A slider dragged past this request makes the answer stale.
      if (result.to.sequenceNumber !== this.position()
        && Math.max(this.position() - 1, 0) !== result.from.sequenceNumber) return;
      this.diff.set(result);
      this.error.set(null);
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }
}

/** The registry loads this module and reads this export. */
export const panelComponent = TimeTravelPanelComponent;
