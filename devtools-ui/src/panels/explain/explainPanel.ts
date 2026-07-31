/**
 * The explain-plan panel (#218) — the last messages one actor handled.
 *
 * Recording is per actor and off by default, so this panel starts by
 * asking you to pick one.  Enabling from here rather than from code is
 * the point: "what has this actor been doing?" is a question you ask
 * while it is misbehaving, not one you can plan for at build time.
 *
 * A DOM table, not a canvas — the rows are text, and the paths want to
 * be selectable and copyable.
 */
import { match } from 'ts-pattern';
import { h, replaceChildren } from '../../core/dom.js';
import { formatCount, formatTime, shortActorPath } from '../../core/format.js';
import { signal } from '../../core/signal.js';
import type { PanelContext, PanelInstance } from '../../shell/PanelRegistry.js';
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

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  const actors = new Map<string, ActorNode>();
  const selected = signal<string | null>(null);
  const recording = signal(false);
  const error = signal<string | null>(null);
  let entries: ExplainEntriesPayload | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const chooser = h('select', {
    class: 'dt-input',
    'aria-label': 'Actor to inspect',
    onchange: (event: Event) => {
      const path = (event.target as HTMLSelectElement).value;
      selected.set(path === '' ? null : path);
      entries = null;
      recording.set(false);
      stopPolling();
      render();
    },
  });

  const toggleButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => void toggleRecording(),
  }, 'Start recording');

  const capacityInput = h('input', {
    class: 'dt-input dt-input--narrow',
    type: 'number',
    min: '1',
    value: '100',
    'aria-label': 'Messages to keep',
  }) as HTMLInputElement;

  const summary = h('span', { class: 'dt-toolbar__summary' });
  const notice = h('div', {});
  const table = h('div', { class: 'dt-explain' });

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Explain plan'),
    h('p', { class: 'dt-panel__subtitle' },
      'Pick an actor and record its recent messages — type, sender, how long each '
      + 'waited in the mailbox and how long it took to handle.'),
    h('div', { class: 'dt-toolbar' }, chooser, capacityInput, toggleButton, summary),
    notice,
    table,
  );

  async function toggleRecording(): Promise<void> {
    const path = selected.get();
    if (path === null) return;
    error.set(null);
    try {
      if (recording.get()) {
        await context.tap.request<ExplainStatusResult>('explain.disable', { path });
        recording.set(false);
        stopPolling();
      } else {
        const capacity = Number.parseInt(capacityInput.value, 10);
        await context.tap.request<ExplainStatusResult>('explain.enable', {
          path,
          ...(Number.isInteger(capacity) && capacity > 0 ? { capacity } : {}),
        });
        recording.set(true);
        startPolling();
        await refresh();
      }
    } catch (cause) {
      error.set((cause as Error).message);
      recording.set(false);
      stopPolling();
    }
    render();
  }

  async function refresh(): Promise<void> {
    const path = selected.get();
    if (path === null) return;
    try {
      entries = await context.tap.request<ExplainEntriesPayload>('explain.fetch', { path });
      error.set(null);
    } catch (cause) {
      // The actor may simply have stopped while we were watching.
      error.set((cause as Error).message);
      recording.set(false);
      stopPolling();
    }
    render();
  }

  function startPolling(): void {
    if (poll !== null) return;
    poll = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (poll === null) return;
    clearInterval(poll);
    poll = null;
  }

  function renderChooser(): void {
    const current = selected.get();
    const paths = [...actors.values()]
      .filter((actor) => !isInternal(actor))
      .map((actor) => actor.path)
      .sort((a, b) => a.localeCompare(b));
    replaceChildren(chooser,
      h('option', { value: '' }, paths.length === 0 ? 'Waiting for the actor tree…' : 'Pick an actor…'),
      ...paths.map((path) => h('option',
        current === path ? { value: path, selected: true } : { value: path },
        path)),
    );
  }

  function render(): void {
    toggleButton.textContent = recording.get() ? 'Stop recording' : 'Start recording';
    (toggleButton as HTMLButtonElement).disabled = selected.get() === null;
    capacityInput.disabled = recording.get();

    const message = error.get();
    replaceChildren(notice, message === null ? null : h('div', { class: 'dt-notice' },
      h('div', { class: 'dt-notice__title' }, 'Could not read the explain plan'),
      h('div', {}, message),
    ));

    if (selected.get() === null) {
      summary.textContent = '';
      replaceChildren(table, h('p', { class: 'dt-empty' }, 'Pick an actor to begin.'));
      return;
    }
    if (entries === null || entries.entries.length === 0) {
      summary.textContent = recording.get() ? 'recording…' : '';
      replaceChildren(table, h('p', { class: 'dt-empty' }, recording.get()
        ? 'Recording. Nothing handled yet — send this actor some work.'
        : 'Not recording. Press “Start recording” to begin.'));
      return;
    }

    const rows = entries.entries;
    summary.textContent = `${formatCount(rows.length)} of ${formatCount(entries.capacity)} kept`;
    replaceChildren(table,
      h('div', { class: 'dt-explain__row dt-explain__row--head' },
        h('span', {}, 'seq'),
        h('span', {}, 'time'),
        h('span', {}, 'message'),
        h('span', {}, 'sender'),
        h('span', {}, 'waited'),
        h('span', {}, 'handled'),
      ),
      // Newest first: the reason you opened this panel is usually the
      // last thing that happened.
      ...[...rows].reverse().map((entry) => h('div', {
        class: 'dt-explain__row',
        title: entry.errorMessage ?? entry.outcome,
      },
        h('span', { class: 'dt-explain__sequence' },
          h('span', { class: `dt-state ${OUTCOME_TOKENS[entry.outcome]}` }),
          String(entry.sequenceNumber),
        ),
        h('span', {}, formatTime(entry.atMs)),
        h('span', { class: 'dt-explain__type' }, entry.messageType),
        h('span', { class: 'dt-explain__sender' },
          entry.senderPath === null ? '—' : shortActorPath(entry.senderPath)),
        h('span', {}, entry.mailboxWaitMs === null ? '—' : formatMilliseconds(entry.mailboxWaitMs)),
        h('span', {}, formatMilliseconds(entry.handleTimeMs)),
      )),
    );
  }

  function onActorTreeSnapshot(payload: ActorTreeSnapshotPayload): boolean {
    actors.clear();
    for (const actor of payload.actors) actors.set(actor.path, actor);
    return true;
  }

  function onActorStarted(payload: ActorStartedPayload): boolean {
    actors.set(payload.actor.path, payload.actor);
    return true;
  }

  function onActorStopped(payload: ActorStoppedPayload): boolean {
    actors.delete(payload.path);
    return true;
  }

  /** Only the chooser's actor list matters here — other frames change nothing. */
  function onOtherActorPayload(): boolean {
    return false;
  }

  const stopActors = context.tap.listen('actors', (payload) => {
    const changed = match(payload)
      .with({ kind: 'actor-tree-snapshot' }, (p) => onActorTreeSnapshot(p))
      .with({ kind: 'actor-started' }, (p) => onActorStarted(p))
      .with({ kind: 'actor-stopped' }, (p) => onActorStopped(p))
      .otherwise(() => onOtherActorPayload());
    if (changed) renderChooser();
  });

  renderChooser();
  render();

  return {
    dispose(): void {
      stopPolling();
      stopActors();
      // Leave the actor as we found it rather than recording forever.
      const path = selected.get();
      if (recording.get() && path !== null) {
        void context.tap.request('explain.disable', { path }).catch(() => {
          /* the socket may already be gone; the server cleans up on detach */
        });
      }
    },
  };
}

/** DevTools' own actors, marked as such by the server. */
function isInternal(actor: ActorNode): boolean {
  return actor.internal;
}

/** Handling times are usually sub-millisecond, so show enough digits. */
function formatMilliseconds(value: number): string {
  if (value >= 100) return `${value.toFixed(0)} ms`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  return `${(value * 1000).toFixed(0)} µs`;
}
