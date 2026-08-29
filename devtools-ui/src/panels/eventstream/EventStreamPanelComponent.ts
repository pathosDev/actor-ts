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
import { TimeControlService } from '../../app/TimeControlService.js';
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
 *
 * Pausing lives in the header now and covers every panel at once (#1349).
 * It also changed meaning here: batches published while time is stopped are
 * held and delivered on resume, where they used to be discarded.  The old
 * reasoning — that resuming into a wall of everything is not what the button
 * promises — was right about a button that only stopped this one tail, and
 * wrong about one that stops the whole view: a reader who froze the world to
 * study it has not asked to be blinded to what it did next.
 */
@Component({
  selector: 'devtools-eventstream-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './EventStreamPanelComponent.html',
})
export class EventStreamPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly time = inject(TimeControlService);
  private readonly destroyRef = inject(DestroyRef);

  /** Newest first, capped — the tail. */
  private readonly tail = signal<readonly BusEvent[]>([]);
  private readonly topicsResult = signal<PubSubTopicsResult | null>(null);

  protected readonly filter = signal('');
  protected readonly paused = this.time.paused;
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
      ? 'Paused. Events are being held, and arrive when you resume.'
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
   * Reached only while time runs: the tap client holds a paused stream's
   * batches and hands them over in arrival order on resume, so this sees the
   * same sequence either way and needs no notion of being paused itself.
   */
  private onBatch(batch: BusEventBatchPayload): void {
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
