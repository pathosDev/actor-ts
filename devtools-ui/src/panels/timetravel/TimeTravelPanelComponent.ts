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
  template: `
    <h1 class="dt-panel__title">Time travel</h1>
    <p class="dt-panel__subtitle">
      Read a persistence journal and reconstruct the state at any point. Read-only —
      nothing here writes to a journal or to a live actor.
    </p>

    <div class="dt-toolbar">
      <select
        class="dt-input"
        aria-label="Persistence id"
        (change)="onSelect($event)"
      >
        <option value="" [selected]="selected() === null">
          {{ identifiers().length === 0 ? 'No persistence ids in this journal' : 'Pick a persistence id…' }}
        </option>
        @for (entry of identifiers(); track entry.persistenceId) {
          <option [value]="entry.persistenceId" [selected]="entry.persistenceId === selected()">
            {{ entry.persistenceId }} ({{ count(entry.highestSequenceNumber) }} events)
          </option>
        }
      </select>
      <span class="dt-toolbar__summary">{{ summary() }}</span>
    </div>

    @if (error(); as message) {
      <div class="dt-notice">
        <div class="dt-notice__title">Could not read the journal</div>
        <div>{{ message }}</div>
      </div>
    }

    <div class="dt-timetravel">
      <div>
        <h2 class="dt-section">Events</h2>
        <div class="dt-timetravel__events">
          @if (events().length === 0) {
            <p class="dt-empty">{{ selected() === null ? 'Pick a persistence id.' : 'This id has no events.' }}</p>
          } @else {
            @for (event of events(); track event.sequenceNumber) {
              <button
                type="button"
                class="dt-event"
                [class.dt-event--current]="event.sequenceNumber === position()"
                [class.dt-event--future]="event.sequenceNumber > position()"
                (click)="onPickEvent(event.sequenceNumber)"
              >
                <span class="dt-event__sequence">{{ event.sequenceNumber }}</span>
                <span class="dt-event__time">{{ at(event.timestampMs) }}</span>
                <span class="dt-event__payload">{{ summarise(event) }}</span>
                @if (event.truncated) {
                  <span class="dt-badge dt-badge--warn">truncated</span>
                }
              </button>
            }
          }
        </div>
      </div>

      <div>
        <h2 class="dt-section">State</h2>
        <div class="dt-timetravel__slider">
          <input
            class="dt-slider"
            type="range"
            min="0"
            aria-label="Sequence number"
            [max]="highest()"
            [value]="position()"
            (input)="onSlide($event)"
          />
        </div>

        <div class="dt-timetravel__state">
          @if (selected() === null) {
            <p class="dt-empty">Pick a persistence id.</p>
          } @else if (noFold()) {
            <div class="dt-notice">
              <div class="dt-notice__title">No fold known for this persistence id</div>
              <div>
                Events can be read without one, but turning them back into state needs
                <code>onEvent</code>, which lives in your actor class. Start the actor that
                owns this id, or register a fold in DevToolsOptions.replayFolds.
              </div>
            </div>
          } @else if (diff() === null) {
            <p class="dt-empty">Reconstructing…</p>
          } @else {
            <div class="dt-kv">
              <dt>At sequence</dt>
              <dd>{{ diff()!.to.sequenceNumber }} of {{ highest() }}</dd>
              <dt>Events folded</dt>
              <dd>{{ count(diff()!.to.eventsApplied) }}</dd>
              <dt>From snapshot</dt>
              <dd>
                {{ diff()!.to.fromSnapshotSequenceNumber === null
                  ? 'none — folded from the start'
                  : 'sequence ' + diff()!.to.fromSnapshotSequenceNumber }}
              </dd>
              <dt>Fold source</dt>
              <dd>{{ capability()?.foldSource ?? 'unknown' }}</dd>
            </div>

            @if (capability()?.foldSource === 'auto-captured') {
              <p class="dt-empty">
                Derived using the running actor’s own onEvent. Accurate as long as that
                fold is pure — which the framework requires of it anyway.
              </p>
            }
            @if (diff()!.to.truncated) {
              <p class="dt-empty">State was truncated for transport; some fields are elided.</p>
            }

            <label class="dt-checkbox">
              <input type="checkbox" [checked]="showUnchanged()" (change)="onToggleUnchanged($event)" />
              Show unchanged fields
            </label>

            @if (visibleDiff().length === 0) {
              <p class="dt-empty">This event changed nothing.</p>
            } @else {
              <div class="dt-diff">
                @for (entry of visibleDiff(); track entry.path) {
                  <div class="dt-diff__row dt-diff__row--{{ entry.kind }}">
                    <span class="dt-diff__path">{{ entry.path === '' ? '(root)' : entry.path }}</span>
                    <span class="dt-diff__before">{{ renderValue(entry.before) }}</span>
                    <span class="dt-diff__arrow">→</span>
                    <span class="dt-diff__after">{{ renderValue(entry.after) }}</span>
                  </div>
                }
              </div>
            }

            <details class="dt-details">
              <summary>Full state at this point</summary>
              <pre class="dt-code">{{ fullState() }}</pre>
            </details>
          }
        </div>
      </div>
    </div>
  `,
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
