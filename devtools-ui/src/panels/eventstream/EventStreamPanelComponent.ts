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
import { formatCount, formatTime } from '../../core/format.js';
import {
  BUS_EVENT_TAIL_ROWS,
  type BusEvent,
  type BusEventBatchPayload,
  type PubSubTopicsResult,
} from '../../../../src/devtools/protocol/index.js';

/**
 * The bus panel (#553) — a live tail of the event stream, and the cluster
 * PubSub topics beside it.
 *
 * The two buses answer different questions and are shown together because
 * the question that brings someone here is the same one: "is anything
 * actually flowing?"  The event stream carries every actor lifecycle
 * event, every dead letter and whatever the application publishes; the
 * PubSub topics are the cluster-wide names anything can subscribe to.
 *
 * The tail is capped and newest-first.  Nothing is recorded on the server
 * until this panel subscribes, so it opens empty and fills — which is what
 * a tail is, and what the empty state says while it waits.
 */
@Component({
  selector: 'devtools-eventstream-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Event stream</h1>
    <p class="dt-panel__subtitle">
      A live tail of the system event bus — actor lifecycle events, dead
      letters, and whatever your actors publish.
    </p>

    <div class="dt-toolbar">
      <input
        class="dt-input"
        type="search"
        placeholder="Filter by event type or payload"
        aria-label="Filter the tail"
        [value]="filter()"
        (input)="onFilter($event)"
      />
      <button
        class="dt-iconbutton"
        type="button"
        [attr.aria-pressed]="paused()"
        (click)="onTogglePause()"
      >{{ paused() ? 'Resume' : 'Pause' }}</button>
      <button class="dt-iconbutton" type="button" (click)="onClear()">Clear</button>
      <span class="dt-toolbar__summary">{{ summary() }}</span>
    </div>

    @if (dropped() > 0) {
      <div class="dt-notice">
        <div class="dt-notice__title">The tail fell behind</div>
        <div>
          {{ formatNumber(dropped()) }} event(s) were dropped by the server's
          buffer. What you see below is the recent past, not everything.
        </div>
      </div>
    }

    <div class="dt-events">
      @if (rows().length === 0) {
        <p class="dt-empty">{{ emptyMessage() }}</p>
      } @else {
        <div class="dt-events__row dt-events__row--head">
          <span>seq</span><span>time</span><span>event</span><span>payload</span>
        </div>
        @for (event of rows(); track event.sequenceNumber) {
          <div
            class="dt-events__row"
            [class.dt-events__row--open]="expanded() === event.sequenceNumber"
            role="button"
            tabindex="0"
            (click)="onToggle(event.sequenceNumber)"
            (keydown.enter)="onToggle(event.sequenceNumber)"
            (keydown.space)="onToggle(event.sequenceNumber)"
          >
            <span>{{ event.sequenceNumber }}</span>
            <span>{{ formatAt(event.atMs) }}</span>
            <span class="dt-events__type">{{ event.eventType }}</span>
            <span class="dt-events__preview">{{ preview(event) }}</span>
          </div>
          @if (expanded() === event.sequenceNumber) {
            <div class="dt-events__detail">
              @if (event.truncated) {
                <p class="dt-events__degraded">
                  Truncated to fit the wire — this is not the whole event.
                </p>
              }
              <pre class="dt-events__payload">{{ payloadOf(event) }}</pre>
            </div>
          }
        }
      }
    </div>

    <h2 class="dt-section__title">Cluster topics</h2>
    @if (topics(); as result) {
      @if (!result.started) {
        <p class="dt-empty">
          Distributed PubSub is not started on this node. It is a cluster
          extension — call DistributedPubSub.get(system).start(cluster) to use it.
        </p>
      } @else if (result.topics.length === 0) {
        <p class="dt-empty">Started, with nothing subscribed to any topic yet.</p>
      } @else {
        <ul class="dt-topics">
          @for (topic of result.topics; track topic) {
            <li class="dt-topics__item">{{ topic }}</li>
          }
        </ul>
      }
    } @else {
      <p class="dt-empty">Loading…</p>
    }
  `,
})
export class EventStreamPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);

  /** Newest first, capped — the tail. */
  private readonly tail = signal<readonly BusEvent[]>([]);
  private readonly topicsResult = signal<PubSubTopicsResult | null>(null);

  protected readonly filter = signal('');
  protected readonly paused = signal(false);
  protected readonly expanded = signal<number | null>(null);
  protected readonly dropped = signal(0);

  protected readonly topics = this.topicsResult.asReadonly();

  protected readonly rows = computed<readonly BusEvent[]>(() => {
    const needle = this.filter().trim().toLowerCase();
    if (needle === '') return this.tail();
    return this.tail().filter((event) =>
      event.eventType.toLowerCase().includes(needle)
      || previewOf(event).toLowerCase().includes(needle));
  });

  protected readonly summary = computed(() => {
    const total = this.tail().length;
    if (total === 0) return this.paused() ? 'paused' : '';
    const shown = this.rows().length;
    const kept = `${formatCount(total)} of ${formatCount(BUS_EVENT_TAIL_ROWS)} kept`;
    const head = shown < total ? `${formatCount(shown)} shown · ${kept}` : kept;
    return this.paused() ? `${head} · paused` : head;
  });

  protected readonly emptyMessage = computed(() => {
    if (this.tail().length > 0) return 'Nothing in the tail matches that filter.';
    return this.paused()
      ? 'Paused. Press Resume to keep tailing.'
      : 'Waiting for the first event. Nothing is recorded until this panel is'
        + ' open, so an idle system shows nothing — that is not a fault.';
  });

  constructor() {
    this.destroyRef.onDestroy(this.tap.listen('events', (payload) => {
      match(payload)
        .with({ kind: 'bus-event-batch' }, (p) => this.onBatch(p))
        .otherwise(() => this.onUnknownPayload());
    }));
    void this.refreshTopics();
  }

  protected formatAt(atMs: number): string { return formatTime(atMs); }
  protected formatNumber(value: number): string { return formatCount(value); }
  protected preview(event: BusEvent): string { return previewOf(event); }

  protected payloadOf(event: BusEvent): string {
    try {
      return JSON.stringify(event.payload, null, 2) ?? String(event.payload);
    } catch {
      return String(event.payload);
    }
  }

  protected onFilter(domEvent: Event): void {
    this.filter.set((domEvent.target as HTMLInputElement).value);
  }

  protected onTogglePause(): void {
    this.paused.update((paused) => !paused);
  }

  protected onClear(): void {
    this.tail.set([]);
    this.dropped.set(0);
    this.expanded.set(null);
  }

  protected onToggle(sequenceNumber: number): void {
    this.expanded.update((current) => (current === sequenceNumber ? null : sequenceNumber));
  }

  /**
   * Take a batch into the tail, newest first.
   *
   * While paused the batch is discarded rather than buffered: pausing a tail
   * means "let me read this", and resuming into a wall of everything that
   * happened meanwhile is not what the button promises.
   */
  private onBatch(batch: BusEventBatchPayload): void {
    if (this.paused()) return;
    if (batch.dropped > 0) this.dropped.update((total) => total + batch.dropped);
    if (batch.events.length === 0) return;
    this.tail.update((current) => {
      const next = [...[...batch.events].reverse(), ...current];
      return next.length > BUS_EVENT_TAIL_ROWS ? next.slice(0, BUS_EVENT_TAIL_ROWS) : next;
    });
  }

  /** A newer server may carry payload kinds this bundle does not know. */
  private onUnknownPayload(): void {}

  private async refreshTopics(): Promise<void> {
    try {
      this.topicsResult.set(await this.tap.request<PubSubTopicsResult>('pubsub.topics'));
    } catch {
      // A node without the cluster extension is the ordinary case, not an
      // error worth a banner over a live tail.
      this.topicsResult.set({ started: false, topics: [] });
    }
  }
}

/** One line of the payload, for the collapsed row. */
function previewOf(event: BusEvent): string {
  if (event.payload === null || event.payload === undefined) return '';
  try {
    const text = JSON.stringify(event.payload) ?? '';
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  } catch {
    return '';
  }
}

export const panelComponent = EventStreamPanelComponent;
