import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount } from '../../core/format.js';
import type {
  ConfigSource,
  ResolvedConfigEntry,
  ResolvedConfigResult,
} from '../../../../src/devtools/protocol/index.js';

/** Source → the semantic colour token that carries its meaning. */
const SOURCE_TOKENS: Readonly<Record<ConfigSource, string>> = {
  reference: 'dt-state--ok',
  application: 'dt-state--warn',
  override: 'dt-state--error',
};

/** Source → what it is called in the file it came from. */
const SOURCE_LABELS: Readonly<Record<ConfigSource, string>> = {
  reference: 'reference.conf',
  application: 'application.conf',
  override: 'code',
};

/**
 * The resolved-config panel (#553).
 *
 * A merged tree answers "what is this setting now".  The question that
 * brings someone here is "why is it not what I wrote", so every key
 * carries the layer that won — bundled default, `application.conf`, or a
 * code override — and whether it displaced a lower one.
 *
 * Configuration is fixed when the system is built, so this is read once
 * rather than polled.  There is nothing to watch change.
 */
@Component({
  selector: 'devtools-config-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Configuration</h1>
    <p class="dt-panel__subtitle">
      Every resolved HOCON key, its effective value, and which layer put it
      there.
    </p>

    <div class="dt-toolbar">
      <input
        class="dt-input"
        type="search"
        placeholder="Filter by key or value"
        aria-label="Filter configuration keys"
        [value]="filter()"
        (input)="onFilter($event)"
      />
      <label class="dt-toggle">
        <input
          type="checkbox"
          [checked]="changedOnly()"
          (change)="onChangedOnly($event)"
        />
        Changed from defaults only
      </label>
      <span class="dt-toolbar__summary">{{ summary() }}</span>
    </div>

    @if (result(); as loaded) {
      @if (!loaded.attributed) {
        <div class="dt-notice">
          <div class="dt-notice__title">Sources are not available</div>
          <div>
            This system's configuration was not built from the usual layers, so
            every key is shown as a default rather than guessed at.
          </div>
        </div>
      }
      <p class="dt-config__origin">
        @if (loaded.applicationPath; as path) {
          application.conf read from <code>{{ path }}</code>
        } @else {
          No application.conf was found — values come from the bundled defaults
          and from code.
        }
      </p>
    }

    <div class="dt-config">
      @if (rows().length === 0) {
        <p class="dt-empty">{{ emptyMessage() }}</p>
      } @else {
        <div class="dt-config__row dt-config__row--head">
          <span>key</span><span>value</span><span>from</span>
        </div>
        @for (entry of rows(); track entry.path) {
          <div class="dt-config__row" [title]="titleOf(entry)">
            <span class="dt-config__key">{{ entry.path }}</span>
            <span class="dt-config__value">{{ display(entry) }}</span>
            <span class="dt-config__source">
              <span class="dt-state {{ sourceToken(entry.source) }}"></span>{{ sourceLabel(entry.source) }}
            </span>
          </div>
        }
      }
    </div>
  `,
})
export class ConfigPanelComponent {
  private readonly tap = inject(TapClientService);

  private readonly resolved = signal<ResolvedConfigResult | null>(null);
  protected readonly filter = signal('');
  protected readonly changedOnly = signal(false);

  protected readonly result = this.resolved.asReadonly();

  protected readonly rows = computed<readonly ResolvedConfigEntry[]>(() => {
    const entries = this.resolved()?.entries ?? [];
    const needle = this.filter().trim().toLowerCase();
    return entries.filter((entry) => {
      if (this.changedOnly() && entry.source === 'reference') return false;
      if (needle === '') return true;
      return entry.path.toLowerCase().includes(needle)
        || displayOf(entry).toLowerCase().includes(needle);
    });
  });

  protected readonly summary = computed(() => {
    const loaded = this.resolved();
    if (loaded === null) return '';
    const shown = this.rows().length;
    const total = loaded.entries.length;
    return shown < total
      ? `${formatCount(shown)} of ${formatCount(total)} keys`
      : `${formatCount(total)} keys`;
  });

  protected readonly emptyMessage = computed(() => {
    if (this.resolved() === null) return 'Loading…';
    if (this.changedOnly() && this.filter().trim() === '') {
      // A worthwhile answer in its own right: nothing has been changed.
      return 'Nothing overrides the bundled defaults.';
    }
    return 'No key matches that filter.';
  });

  constructor() {
    void this.load();
  }

  protected sourceToken(source: ConfigSource): string { return SOURCE_TOKENS[source]; }
  protected sourceLabel(source: ConfigSource): string { return SOURCE_LABELS[source]; }
  protected display(entry: ResolvedConfigEntry): string { return displayOf(entry); }

  protected titleOf(entry: ResolvedConfigEntry): string {
    const from = `from ${SOURCE_LABELS[entry.source]}`;
    const displaced = entry.overridden ? ', overriding a lower layer' : '';
    const cut = entry.truncated ? ' (value truncated)' : '';
    return `${entry.path} — ${from}${displaced}${cut}`;
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected onChangedOnly(event: Event): void {
    this.changedOnly.set((event.target as HTMLInputElement).checked);
  }

  private async load(): Promise<void> {
    try {
      this.resolved.set(await this.tap.request<ResolvedConfigResult>('config.resolved'));
    } catch {
      this.resolved.set({ entries: [], applicationPath: null, attributed: false });
    }
  }
}

/** Render a value on one line, keeping a list readable as a list. */
function displayOf(entry: ResolvedConfigEntry): string {
  const value = entry.value;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const panelComponent = ConfigPanelComponent;
