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
import { formatTime, shortActorPath } from '../../core/format.js';
import type {
  ActorNode,
  ActorTreeSnapshotPayload,
  SendMessageResult,
} from '../../../../src/devtools/protocol/index.js';

/** How many sends the panel remembers, so a session has a trail. */
const SENT_LOG_ROWS = 20;

/**
 * The send-message panel (#553) — the one action DevTools offers.
 *
 * Every other panel reads.  This one writes into a running system, so it
 * is off unless the operator acknowledged it in code, and the nav entry
 * explains that rather than hiding.
 *
 * The actor chooser is fed by the `actors` stream, which is also what
 * keeps it honest: an actor that stops disappears from the list rather
 * than staying selectable until the send fails.
 */
@Component({
  selector: 'devtools-send-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Send message</h1>
    <p class="dt-panel__subtitle">
      Send a JSON message to one of your actors. The server accepts this only
      when message sending was acknowledged in code.
    </p>

    <div class="dt-toolbar">
      <select class="dt-input" aria-label="Recipient actor" (change)="onSelect($event)">
        <option value="" [selected]="selected() === null">
          {{ paths().length === 0 ? 'Waiting for the actor tree…' : 'Pick an actor…' }}
        </option>
        @for (path of paths(); track path) {
          <option [value]="path" [selected]="path === selected()">{{ path }}</option>
        }
      </select>
      <button
        class="dt-iconbutton"
        type="button"
        [disabled]="!canSend()"
        (click)="onSend()"
      >Send</button>
    </div>

    <label class="dt-send__label" for="dt-send-body">Message, as JSON</label>
    <textarea
      id="dt-send-body"
      class="dt-send__body"
      rows="8"
      spellcheck="false"
      [value]="body()"
      (input)="onBody($event)"
    ></textarea>

    @if (error(); as message) {
      <div class="dt-notice">
        <div class="dt-notice__title">The message was not sent</div>
        <div>{{ message }}</div>
      </div>
    }

    <h2 class="dt-section__title">Sent this session</h2>
    @if (sent().length === 0) {
      <p class="dt-empty">Nothing sent yet.</p>
    } @else {
      <div class="dt-send__log">
        @for (entry of sent(); track entry.atMs) {
          <div class="dt-send__row">
            <span>{{ formatAt(entry.atMs) }}</span>
            <span class="dt-send__type">{{ entry.messageType }}</span>
            <span>{{ shortPath(entry.path) }}</span>
          </div>
        }
      </div>
    }
  `,
})
export class SendPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly tree = signal<readonly ActorNode[]>([]);
  private readonly log = signal<readonly SendMessageResult[]>([]);

  protected readonly selected = signal<string | null>(null);
  protected readonly body = signal('{\n  "kind": ""\n}');
  protected readonly error = signal<string | null>(null);

  protected readonly sent = this.log.asReadonly();

  protected readonly paths = computed(() =>
    this.tree()
      .map((node) => node.path)
      // Only the user tree can be sent to, so offering anything else would
      // be a choice the server is going to refuse.
      .filter((path) => path.includes('/user/'))
      .sort((left, right) => left.localeCompare(right)));

  protected readonly canSend = computed(() =>
    this.selected() !== null && this.body().trim().length > 0);

  constructor() {
    this.destroyRef.onDestroy(this.tap.listen('actors', (payload) => {
      match(payload)
        .with({ kind: 'actor-tree-snapshot' }, (p) => this.onActorTreeSnapshot(p))
        .otherwise(() => this.onOtherActorPayload());
    }));
  }

  protected formatAt(atMs: number): string { return formatTime(atMs); }
  protected shortPath(path: string): string { return shortActorPath(path); }

  protected onSelect(event: Event): void {
    const path = (event.target as HTMLSelectElement).value;
    this.selected.set(path === '' ? null : path);
    this.error.set(null);
  }

  protected onBody(event: Event): void {
    this.body.set((event.target as HTMLTextAreaElement).value);
  }

  async onSend(): Promise<void> {
    const path = this.selected();
    if (path === null) return;
    this.error.set(null);
    try {
      const result = await this.tap.request<SendMessageResult>('actors.send', {
        path,
        body: this.body(),
      });
      // Newest first, and capped: a trail is useful, an unbounded one is a
      // second thing to scroll.
      this.log.update((current) => [result, ...current].slice(0, SENT_LOG_ROWS));
    } catch (cause) {
      // The server does the validating — the panel repeating those rules
      // would be a second place for them to drift out of step.
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private onActorTreeSnapshot(payload: ActorTreeSnapshotPayload): void {
    this.tree.set(payload.actors);
  }

  /** Lifecycle deltas are ignored; the next snapshot carries them. */
  private onOtherActorPayload(): void {}
}

export const panelComponent = SendPanelComponent;
