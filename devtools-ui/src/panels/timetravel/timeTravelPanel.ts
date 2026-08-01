/**
 * The time-travel panel (#201) — browse a journal, reconstruct state.
 *
 * Strictly read-only.  Pick a persistence id, drag the slider to a
 * sequence number, see the state as it was and what the event at that
 * point changed.
 *
 * Where no fold is known the panel degrades honestly: the event log
 * still works, the state pane says why it cannot show a state.  Turning
 * events back into state needs `onEvent`, which lives in the user's
 * actor class and cannot be recovered from stored data.
 */
import { h, replaceChildren } from '../../core/dom.js';
import { formatCount, formatTime } from '../../core/format.js';
import { signal } from '../../core/signal.js';
import type { PanelContext, PanelInstance } from '../../shell/PanelRegistry.js';
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

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  let identifiers: ReadonlyArray<JournalIdentifierInfo> = [];
  let events: ReadonlyArray<JournalEventView> = [];
  let capability: ReplayCapabilitiesResult | null = null;
  let diff: ReplayDiffResult | null = null;
  let disposed = false;

  const selected = signal<string | null>(null);
  const position = signal(0);
  const error = signal<string | null>(null);
  const showUnchanged = signal(false);

  const chooser = h('select', {
    class: 'dt-input',
    'aria-label': 'Persistence id',
    onchange: (event: Event) => {
      const value = (event.target as HTMLSelectElement).value;
      selected.set(value === '' ? null : value);
      void loadSelected();
    },
  });
  const slider = h('input', {
    class: 'dt-slider',
    type: 'range',
    min: '0',
    max: '0',
    value: '0',
    'aria-label': 'Sequence number',
    oninput: (event: Event) => {
      position.set(Number((event.target as HTMLInputElement).value));
      renderTimeline();
      void loadState();
    },
  }) as HTMLInputElement;

  const summary = h('span', { class: 'dt-toolbar__summary' });
  const notice = h('div', {});
  const timeline = h('div', { class: 'dt-timetravel__events' });
  const statePane = h('div', { class: 'dt-timetravel__state' });

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Time travel'),
    h('p', { class: 'dt-panel__subtitle' },
      'Read a persistence journal and reconstruct the state at any point. Read-only — '
      + 'nothing here writes to a journal or to a live actor.'),
    h('div', { class: 'dt-toolbar' }, chooser, summary),
    notice,
    h('div', { class: 'dt-timetravel' },
      h('div', {}, h('h2', { class: 'dt-section' }, 'Events'), timeline),
      h('div', {},
        h('h2', { class: 'dt-section' }, 'State'),
        h('div', { class: 'dt-timetravel__slider' }, slider),
        statePane,
      ),
    ),
  );

  async function loadIdentifiers(): Promise<void> {
    try {
      const result = await context.tap.request<JournalIdentifiersResult>('journal.ids');
      if (disposed) return;
      identifiers = result.identifiers;
      error.set(null);
    } catch (cause) {
      error.set((cause as Error).message);
    }
    renderChooser();
    render();
  }

  async function loadSelected(): Promise<void> {
    const persistenceId = selected.get();
    events = [];
    diff = null;
    capability = null;
    position.set(0);
    if (persistenceId === null) {
      render();
      return;
    }
    try {
      const [page, caps] = await Promise.all([
        context.tap.request<JournalReadResult>('journal.read', {
          persistenceId, fromSequenceNumber: 1, limit: PAGE_SIZE,
        }),
        context.tap.request<ReplayCapabilitiesResult>('replay.capabilities', { persistenceId }),
      ]);
      if (disposed) return;
      events = page.events;
      capability = caps;
      slider.max = String(page.highestSequenceNumber);
      position.set(page.highestSequenceNumber);
      slider.value = String(page.highestSequenceNumber);
      error.set(null);
      await loadState();
    } catch (cause) {
      error.set((cause as Error).message);
      render();
    }
  }

  /**
   * Fetch the state at the slider position and at the step before it,
   * so the panel can show what the event at that point actually did —
   * which is the question, more often than the absolute state.
   */
  async function loadState(): Promise<void> {
    const persistenceId = selected.get();
    if (persistenceId === null || capability?.capability !== 'state') {
      render();
      return;
    }
    const to = position.get();
    try {
      const result = await context.tap.request<ReplayDiffResult>('replay.diff', {
        persistenceId,
        fromSequenceNumber: Math.max(to - 1, 0),
        toSequenceNumber: to,
      });
      if (disposed) return;
      // A slider dragged past this request makes the answer stale.
      if (result.to.sequenceNumber !== position.get()
        && Math.max(position.get() - 1, 0) !== result.from.sequenceNumber) return;
      diff = result;
      error.set(null);
    } catch (cause) {
      error.set((cause as Error).message);
    }
    render();
  }

  function renderChooser(): void {
    const current = selected.get();
    replaceChildren(chooser,
      h('option', { value: '' },
        identifiers.length === 0 ? 'No persistence ids in this journal' : 'Pick a persistence id…'),
      ...identifiers.map((entry) => h('option',
        current === entry.persistenceId
          ? { value: entry.persistenceId, selected: true }
          : { value: entry.persistenceId },
        `${entry.persistenceId} (${formatCount(entry.highestSequenceNumber)} events)`)),
    );
  }

  function renderTimeline(): void {
    if (events.length === 0) {
      replaceChildren(timeline, h('p', { class: 'dt-empty' },
        selected.get() === null ? 'Pick a persistence id.' : 'This id has no events.'));
      return;
    }
    const at = position.get();
    replaceChildren(timeline, ...events.map((event) => {
      const classes = ['dt-event'];
      if (event.sequenceNumber === at) classes.push('dt-event--current');
      if (event.sequenceNumber > at) classes.push('dt-event--future');
      return h('button', {
        class: classes.join(' '),
        type: 'button',
        onclick: () => {
          position.set(event.sequenceNumber);
          slider.value = String(event.sequenceNumber);
          renderTimeline();
          void loadState();
        },
      },
        h('span', { class: 'dt-event__sequence' }, String(event.sequenceNumber)),
        h('span', { class: 'dt-event__time' }, formatTime(event.timestampMs)),
        h('span', { class: 'dt-event__payload' }, summarise(event)),
        event.truncated ? h('span', { class: 'dt-badge dt-badge--warn' }, 'truncated') : null,
      );
    }));
  }

  function renderState(): void {
    if (selected.get() === null) {
      replaceChildren(statePane, h('p', { class: 'dt-empty' }, 'Pick a persistence id.'));
      return;
    }
    if (capability !== null && capability.capability !== 'state') {
      replaceChildren(statePane, h('div', { class: 'dt-notice' },
        h('div', { class: 'dt-notice__title' }, 'No fold known for this persistence id'),
        h('div', {},
          'Events can be read without one, but turning them back into state needs '
          + '`onEvent`, which lives in your actor class. Start the actor that owns this '
          + 'id, or register a fold in DevToolsOptions.replayFolds.'),
      ));
      return;
    }
    if (diff === null) {
      replaceChildren(statePane, h('p', { class: 'dt-empty' }, 'Reconstructing…'));
      return;
    }

    const entries = diffStates(diff.from.state, diff.to.state);
    const visible = showUnchanged.get() ? entries : changedOnly(entries);
    const toggle = h('label', { class: 'dt-checkbox' },
      h('input', {
        type: 'checkbox',
        ...(showUnchanged.get() ? { checked: true } : {}),
        onchange: (event: Event) => {
          showUnchanged.set((event.target as HTMLInputElement).checked);
          renderState();
        },
      }),
      'Show unchanged fields',
    );

    replaceChildren(statePane,
      h('div', { class: 'dt-kv' },
        h('dt', {}, 'At sequence'),
        h('dd', {}, `${diff.to.sequenceNumber} of ${slider.max}`),
        h('dt', {}, 'Events folded'),
        h('dd', {}, formatCount(diff.to.eventsApplied)),
        h('dt', {}, 'From snapshot'),
        h('dd', {}, diff.to.fromSnapshotSequenceNumber === null
          ? 'none — folded from the start'
          : `sequence ${diff.to.fromSnapshotSequenceNumber}`),
        h('dt', {}, 'Fold source'),
        h('dd', {}, capability?.foldSource ?? 'unknown'),
      ),
      capability?.foldSource === 'auto-captured'
        ? h('p', { class: 'dt-empty' },
          'Derived using the running actor’s own onEvent. Accurate as long as that fold '
          + 'is pure — which the framework requires of it anyway.')
        : null,
      diff.to.truncated
        ? h('p', { class: 'dt-empty' }, 'State was truncated for transport; some fields are elided.')
        : null,
      toggle,
      visible.length === 0
        ? h('p', { class: 'dt-empty' }, 'This event changed nothing.')
        : h('div', { class: 'dt-diff' }, ...visible.map(renderDiffRow)),
      h('details', { class: 'dt-details' },
        h('summary', {}, 'Full state at this point'),
        h('pre', { class: 'dt-code' }, JSON.stringify(diff.to.state, null, 2)),
      ),
    );
  }

  function render(): void {
    const persistenceId = selected.get();
    summary.textContent = persistenceId === null
      ? `${formatCount(identifiers.length)} persistence ids`
      : `${formatCount(events.length)} events loaded`;
    const message = error.get();
    replaceChildren(notice, message === null ? null : h('div', { class: 'dt-notice' },
      h('div', { class: 'dt-notice__title' }, 'Could not read the journal'),
      h('div', {}, message),
    ));
    renderTimeline();
    renderState();
  }

  void loadIdentifiers();

  return {
    dispose(): void {
      // Every request is read-only, so there is nothing to undo — just
      // stop applying answers that arrive after we are gone.
      disposed = true;
    },
  };
}

function renderDiffRow(entry: DiffEntry): HTMLElement {
  return h('div', { class: `dt-diff__row dt-diff__row--${entry.kind}` },
    h('span', { class: 'dt-diff__path' }, entry.path === '' ? '(root)' : entry.path),
    h('span', { class: 'dt-diff__before' }, render_(entry.before)),
    h('span', { class: 'dt-diff__arrow' }, '→'),
    h('span', { class: 'dt-diff__after' }, render_(entry.after)),
  );
}

function render_(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

/** One-line preview of an event payload for the timeline. */
function summarise(event: JournalEventView): string {
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
