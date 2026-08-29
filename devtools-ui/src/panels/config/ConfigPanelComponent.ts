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
  templateUrl: './ConfigPanelComponent.html',
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
