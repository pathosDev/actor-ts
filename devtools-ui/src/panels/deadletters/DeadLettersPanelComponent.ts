import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatTime, shortActorPath } from '../../core/format.js';
import type {
  DeadLettersResult,
  DeadLetterView,
} from '../../../../src/devtools/protocol/index.js';

/** How often the queue is re-pulled. */
const POLL_INTERVAL_MS = 1000;

/**
 * The dead-letter inspector (#553) — what the system failed to deliver.
 *
 * A message becomes a dead letter when its recipient is gone, was never
 * there, or the path was wrong.  Nothing throws and nothing logs by
 * default, which is what makes the failure so easy to miss: the send
 * returns, the sender carries on, and the work silently never happens.
 * This panel is the place that failure becomes visible.
 *
 * A DOM table, not a canvas — paths and payloads want to be selectable
 * and copyable.
 *
 * This panel POLLS, for the reason the explain plan does: the queue is a
 * bounded ring the server already keeps, so a request per second is far
 * cheaper than pushing every capture — and pushing would put DevTools on
 * the delivery path of the very failures it is watching.
 */
@Component({
  selector: 'devtools-deadletters-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Dead letters</h1>
    <p class="dt-panel__subtitle">
      Messages the system could not deliver — the recipient was gone, never
      existed, or the path was wrong. Newest first.
    </p>

    <div class="dt-toolbar">
      <input
        class="dt-input"
        type="search"
        placeholder="Filter by recipient path, e.g. /user/orders"
        aria-label="Filter by recipient path"
        [value]="recipient()"
        (input)="onRecipient($event)"
      />
      <span class="dt-toolbar__summary">{{ summary() }}</span>
    </div>

    @if (error(); as message) {
      <div class="dt-notice">
        <div class="dt-notice__title">Could not read the dead-letter queue</div>
        <div>{{ message }}</div>
      </div>
    }

    <div class="dt-deadletters">
      @if (rows().length === 0) {
        <p class="dt-empty">{{ emptyMessage() }}</p>
      } @else {
        <div class="dt-deadletters__row dt-deadletters__row--head">
          <span>time</span><span>message</span><span>recipient</span>
          <span>sender</span><span>replays</span>
        </div>
        @for (entry of rows(); track entry.id) {
          <div
            class="dt-deadletters__row"
            [class.dt-deadletters__row--open]="expanded() === entry.id"
            role="button"
            tabindex="0"
            [attr.aria-expanded]="expanded() === entry.id"
            [title]="entry.recipientPath"
            (click)="onToggle(entry.id)"
            (keydown.enter)="onToggle(entry.id)"
            (keydown.space)="onToggle(entry.id)"
          >
            <span>{{ formatAt(entry.timestampMs) }}</span>
            <span class="dt-deadletters__type">{{ entry.messageType }}</span>
            <span>{{ shortPath(entry.recipientPath) }}</span>
            <span>{{ senderOf(entry.senderPath) }}</span>
            <span>
              @if (entry.replayCount > 0) {
                <span class="dt-state dt-state--warn"></span>{{ entry.replayCount }}
              } @else {
                —
              }
            </span>
          </div>
          @if (expanded() === entry.id) {
            <div class="dt-deadletters__detail">
              @if (entry.degradedReason; as reason) {
                <p class="dt-deadletters__degraded">
                  The payload was not kept: {{ reason }}
                </p>
              } @else {
                @if (entry.truncated) {
                  <p class="dt-deadletters__degraded">
                    Truncated to fit the wire — this is not the whole message.
                  </p>
                }
                <pre class="dt-deadletters__payload">{{ payloadOf(entry) }}</pre>
              }
            </div>
          }
        }
      }
    </div>
  `,
})
export class DeadLettersPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly result = signal<DeadLettersResult | null>(null);
  protected readonly recipient = signal('');
  protected readonly expanded = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly rows = computed<readonly DeadLetterView[]>(
    () => this.result()?.entries ?? [],
  );

  protected readonly summary = computed(() => {
    const payload = this.result();
    if (payload === null) return '';
    const shown = payload.entries.length;
    const kept = `${formatCount(payload.total)} of ${formatCount(payload.capacity)} kept`;
    // Only worth saying when the page is actually smaller than the ring —
    // "200 of 200 shown" on a queue holding 200 is noise.
    return shown < payload.total ? `${formatCount(shown)} shown · ${kept}` : kept;
  });

  protected readonly emptyMessage = computed(() => {
    if (this.result() === null) return 'Loading…';
    return this.recipient() === ''
      ? 'No dead letters. Every message the system sent has been delivered.'
      : 'No dead letters below that path.';
  });

  private poll: ReturnType<typeof setInterval> | null = null;
  /** Debounces the filter box so typing does not issue a request per keystroke. */
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.refresh();
    this.poll = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    this.destroyRef.onDestroy(() => {
      if (this.poll !== null) clearInterval(this.poll);
      if (this.debounce !== null) clearTimeout(this.debounce);
    });
  }

  protected formatAt(atMs: number): string { return formatTime(atMs); }
  protected shortPath(path: string): string { return shortActorPath(path); }
  protected senderOf(path: string | null): string {
    return path === null ? '—' : shortActorPath(path);
  }

  /** Pretty-print the payload; it is already sanitised server-side. */
  protected payloadOf(entry: DeadLetterView): string {
    try {
      return JSON.stringify(entry.payload, null, 2) ?? String(entry.payload);
    } catch {
      // Should not happen — the server ran it through the wire serialiser —
      // but a panel about undelivered messages is a poor place to throw.
      return String(entry.payload);
    }
  }

  protected onRecipient(event: Event): void {
    this.recipient.set((event.target as HTMLInputElement).value);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 200);
  }

  protected onToggle(id: string): void {
    this.expanded.update((current) => (current === id ? null : id));
  }

  private async refresh(): Promise<void> {
    const recipient = this.recipient().trim();
    try {
      this.result.set(await this.tap.request<DeadLettersResult>(
        'deadletters.list',
        recipient === '' ? {} : { recipient },
      ));
      this.error.set(null);
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }
}

export const panelComponent = DeadLettersPanelComponent;
