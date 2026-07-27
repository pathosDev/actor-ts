/**
 * The actors panel (#204) — the live tree, with mailbox depths.
 *
 * A DOM list rather than a canvas: the tree needs selection, text
 * search, keyboard access and copyable paths, all of which a canvas
 * would have to reimplement badly.  Rows are rebuilt on each frame,
 * which at DevTools' scale is cheaper than diffing and keeps the code
 * honest about what is on screen.
 */
import { h, replaceChildren } from '../../core/dom.js';
import { formatCount } from '../../core/format.js';
import { signal } from '../../core/signal.js';
import type { PanelContext, PanelInstance } from '../../shell/PanelRegistry.js';
import { ActorTreeModel, type TreeRow } from './actorsTree.js';
import type { ActorCellState, MailboxDepthEntry } from '../../../../src/devtools/protocol/index.js';

/** DevTools' own actors, which would otherwise clutter the tree. */
const DEVTOOLS_ACTOR_PREFIX = 'devtools-';

/** Cell state → the semantic colour token that carries its meaning. */
const STATE_TOKENS: Readonly<Record<ActorCellState, string>> = {
  creating: 'dt-state--pending',
  running: 'dt-state--ok',
  suspended: 'dt-state--warn',
  terminating: 'dt-state--warn',
  terminated: 'dt-state--error',
};

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  const model = new ActorTreeModel();
  const filter = signal('');
  const hideInternal = signal(true);
  const mailboxes = new Map<string, MailboxDepthEntry>();

  const rowsHost = h('div', { class: 'dt-tree' });
  const summary = h('span', { class: 'dt-toolbar__summary' });

  const search = h('input', {
    class: 'dt-input',
    type: 'search',
    placeholder: 'Filter by path or class…',
    'aria-label': 'Filter actors',
    oninput: (event: Event) => {
      filter.set((event.target as HTMLInputElement).value);
      render();
    },
  });

  const internalToggle = h('label', { class: 'dt-checkbox' },
    h('input', {
      type: 'checkbox',
      checked: true,
      onchange: (event: Event) => {
        hideInternal.set((event.target as HTMLInputElement).checked);
        render();
      },
    }),
    'Hide DevTools actors',
  );

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Actors'),
    h('p', { class: 'dt-panel__subtitle' },
      'The live supervision tree. Depth counts messages waiting in the mailbox.'),
    h('div', { class: 'dt-toolbar' }, search, internalToggle, summary),
    rowsHost,
  );

  function render(): void {
    const rows = model.rows(filter.get())
      .filter((row) => !hideInternal.get() || !isInternal(row));
    summary.textContent = `${formatCount(rows.length)} of ${formatCount(model.size)} actors`;
    if (rows.length === 0) {
      replaceChildren(rowsHost, h('p', { class: 'dt-empty' },
        model.size === 0 ? 'Waiting for the actor tree…' : 'No actor matches that filter.'));
      return;
    }
    replaceChildren(rowsHost, ...rows.map((row) => renderRow(row, mailboxes, () => {
      model.toggle(row.node.path);
      render();
    })));
  }

  const stopActors = context.tap.listen('actors', (payload) => {
    switch (payload.kind) {
      case 'actor-tree-snapshot':
        model.reset(payload.actors);
        break;
      case 'actor-started':
        model.upsert(payload.actor);
        break;
      case 'actor-stopped':
        model.remove(payload.path);
        break;
      case 'actor-restarted':
        // The path survives a restart, so nothing structural changes —
        // but the row should say so.
        flashRestart(rowsHost, payload.path);
        return;
      default:
        return;
    }
    render();
  });

  // Mailbox depths arrive on their own stream so the tree does not have
  // to be re-sent every second just to update a number.
  const stopMailboxes = context.tap.listen('mailboxes', (payload) => {
    if (payload.kind !== 'mailbox-sample') return;
    mailboxes.clear();
    for (const entry of payload.entries) mailboxes.set(entry.path, entry);
    render();
  });

  render();

  return {
    dispose(): void {
      stopActors();
      stopMailboxes();
    },
  };
}

function isInternal(row: TreeRow): boolean {
  return row.node.name.startsWith(DEVTOOLS_ACTOR_PREFIX);
}

function renderRow(
  row: TreeRow,
  mailboxes: ReadonlyMap<string, MailboxDepthEntry>,
  onToggle: () => void,
): HTMLElement {
  const node = row.node;
  // The sampled depth is fresher than the one carried by the tree
  // delta, which was accurate only at spawn time.
  const depth = mailboxes.get(node.path)?.size ?? node.mailboxSize;

  const twisty = row.hasChildren
    ? h('button', {
      class: 'dt-tree__twisty',
      type: 'button',
      'aria-label': row.expanded ? 'Collapse' : 'Expand',
      onclick: onToggle,
    }, row.expanded ? '▾' : '▸')
    : h('span', { class: 'dt-tree__twisty dt-tree__twisty--leaf' });

  return h('div', {
    class: 'dt-tree__row',
    style: `--dt-tree-depth:${row.depth}`,
    title: node.path,
  },
    twisty,
    h('span', { class: `dt-state ${STATE_TOKENS[node.cellState]}`, title: node.cellState }),
    h('span', { class: 'dt-tree__name' }, node.name === '' ? '/' : node.name),
    h('span', { class: 'dt-tree__class' }, node.className),
    depth > 0
      ? h('span', { class: 'dt-badge dt-badge--warn', title: 'messages waiting' }, formatCount(depth))
      : null,
    node.stashSize > 0
      ? h('span', { class: 'dt-badge', title: 'stashed messages' }, `stash ${formatCount(node.stashSize)}`)
      : null,
    node.suspended ? h('span', { class: 'dt-badge dt-badge--error' }, 'suspended') : null,
  );
}

/** Briefly mark a row that just restarted; the tree itself is unchanged. */
function flashRestart(host: HTMLElement, path: string): void {
  const row = [...host.querySelectorAll<HTMLElement>('.dt-tree__row')]
    .find((candidate) => candidate.title === path);
  if (row === undefined) return;
  row.classList.remove('dt-tree__row--restarted');
  // Force a reflow so re-adding the class restarts the animation.
  void row.offsetWidth;
  row.classList.add('dt-tree__row--restarted');
}
