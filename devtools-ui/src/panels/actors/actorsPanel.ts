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
import type {
  ActorCellState,
  ActorNode,
  MailboxDepthEntry,
} from '../../../../src/devtools/protocol/index.js';

/**
 * How long a stopped actor stays on screen, greyed and red.
 *
 * Long enough to notice and read after the fact — the interesting actor
 * is usually the one that just died — and short enough that a system
 * churning actors does not turn the tree into a graveyard.
 */
const STOPPED_RETENTION_MS = 30_000;

/** Ticks the "stopped 12s" badges and runs the sweeper. */
const SWEEP_INTERVAL_MS = 1000;

/** Cell state → the semantic colour token that carries its meaning. */
const STATE_TOKENS: Readonly<Record<ActorCellState, string>> = {
  creating: 'dt-state--pending',
  running: 'dt-state--ok',
  suspended: 'dt-state--warn',
  terminating: 'dt-state--warn',
  terminated: 'dt-state--error',
};

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  /**
   * One tree per node.  Paths repeat across a cluster — every node runs
   * the same system name, so `/user/orders` exists on all of them — and
   * a single map keyed by path would have them overwrite each other.
   */
  const models = new Map<string, ActorTreeModel>();
  const modelFor = (address: string): ActorTreeModel => {
    const existing = models.get(address);
    if (existing !== undefined) return existing;
    const created = new ActorTreeModel();
    models.set(address, created);
    return created;
  };
  const filter = signal('');
  const hideInternal = signal(true);
  const showStopped = signal(true);
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

  const stoppedToggle = h('label', { class: 'dt-checkbox' },
    h('input', {
      type: 'checkbox',
      checked: true,
      onchange: (event: Event) => {
        showStopped.set((event.target as HTMLInputElement).checked);
        render();
      },
    }),
    `Keep stopped for ${STOPPED_RETENTION_MS / 1000}s`,
  );

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Actors'),
    h('p', { class: 'dt-panel__subtitle' },
      'The live supervision tree. Depth counts messages waiting in the mailbox.'),
    h('div', { class: 'dt-toolbar' }, search, internalToggle, stoppedToggle, summary),
    rowsHost,
  );

  function render(): void {
    const now = Date.now();
    const addresses = [...models.keys()].sort();
    const grouped = addresses.length > 1;
    const blocks: Array<HTMLElement> = [];
    let shown = 0;
    let live = 0;
    let stoppedShown = 0;

    for (const address of addresses) {
      const model = models.get(address)!;
      // Age out tombstones here rather than only on a timer: a background
      // browser tab has its intervals throttled to about once a minute,
      // and a rendered frame is the moment it actually matters.
      model.sweep(now, STOPPED_RETENTION_MS);
      let rows = withoutInternal(model.rows(filter.get()), hideInternal.get());
      if (!showStopped.get()) rows = rows.filter((row) => row.stoppedAtMs === null);
      live += model.size;
      shown += rows.length;
      stoppedShown += rows.filter((row) => row.stoppedAtMs !== null).length;
      if (rows.length === 0) continue;

      if (grouped) {
        blocks.push(h('h3', { class: 'dt-tree__node' },
          address,
          h('span', { class: 'dt-tree__nodecount' }, `${formatCount(rows.length)}`),
        ));
      }
      blocks.push(...rows.map((row) => renderRow(row, mailboxes, now, () => {
        model.toggle(row.node.path);
        render();
      })));
    }

    // Tombstones are rows but not population, so they are counted apart
    // rather than inflating "n of m actors" past m.
    summary.textContent = `${formatCount(shown - stoppedShown)} of ${formatCount(live)} actors`
      + (grouped ? ` across ${formatCount(addresses.length)} nodes` : '')
      + (stoppedShown > 0 ? ` · ${formatCount(stoppedShown)} recently stopped` : '');
    if (blocks.length === 0) {
      replaceChildren(rowsHost, h('p', { class: 'dt-empty' },
        live === 0 ? 'Waiting for the actor tree…' : 'No actor matches that filter.'));
      return;
    }
    replaceChildren(rowsHost, ...blocks);
  }

  const stopActors = context.tap.listen('actors', (payload) => {
    switch (payload.kind) {
      case 'actor-tree-snapshot':
        // One frame can carry several nodes; each replaces its own tree.
        for (const [address, actors] of byNode(payload.actors)) {
          modelFor(address).reset(actors);
        }
        break;
      case 'actor-node-tree':
        modelFor(payload.address).applyFullTree(payload.actors, payload.atMs);
        break;
      case 'actor-started':
      case 'actor-changed':
        modelFor(payload.actor.nodeAddress).upsert(payload.actor);
        break;
      case 'actor-stopped':
        modelFor(payload.nodeAddress).markStopped(payload.path, payload.atMs);
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

  // Nothing on the wire says "that row is now old enough to drop", and
  // on an idle system no frame arrives to trigger a render either.  The
  // sweeping itself happens in `render`, so this only has to keep the
  // badges counting up — throttling it in a background tab is harmless.
  const sweeper = setInterval(() => {
    for (const model of models.values()) {
      if (model.stoppedCount > 0) { render(); return; }
    }
  }, SWEEP_INTERVAL_MS);

  render();

  return {
    dispose(): void {
      clearInterval(sweeper);
      stopActors();
      stopMailboxes();
    },
  };
}

/** Split one snapshot into the trees it actually contains. */
function byNode(
  actors: ReadonlyArray<ActorNode>,
): ReadonlyMap<string, ActorNode[]> {
  const out = new Map<string, ActorNode[]>();
  for (const actor of actors) {
    const bucket = out.get(actor.nodeAddress);
    if (bucket === undefined) out.set(actor.nodeAddress, [actor]);
    else bucket.push(actor);
  }
  return out;
}

/**
 * Drop DevTools' own actors.
 *
 * The server marks them, so this no longer has to guess from names —
 * which missed their children, and a DevTools websocket connection is a
 * child of the DevTools hub.
 */
function withoutInternal(
  rows: ReadonlyArray<TreeRow>,
  hide: boolean,
): ReadonlyArray<TreeRow> {
  return hide ? rows.filter((row) => !row.node.internal) : rows;
}

function renderRow(
  row: TreeRow,
  mailboxes: ReadonlyMap<string, MailboxDepthEntry>,
  nowMs: number,
  onToggle: () => void,
): HTMLElement {
  const node = row.node;
  const stopped = row.stoppedAtMs !== null;
  // The sampled depth is fresher than the one carried by the tree
  // delta, which was accurate only at spawn time — but a stopped actor
  // is not in the sample any more, so its last known depth is the truth.
  const depth = stopped ? node.mailboxSize : mailboxes.get(node.path)?.size ?? node.mailboxSize;

  const twisty = row.hasChildren
    ? h('button', {
      class: 'dt-tree__twisty',
      type: 'button',
      'aria-label': row.expanded ? 'Collapse' : 'Expand',
      onclick: onToggle,
    }, row.expanded ? '▾' : '▸')
    : h('span', { class: 'dt-tree__twisty dt-tree__twisty--leaf' });

  return h('div', {
    class: stopped ? 'dt-tree__row dt-tree__row--stopped' : 'dt-tree__row',
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
    stopped
      ? h('span', { class: 'dt-badge dt-badge--error', title: 'removed shortly' },
        `stopped ${Math.max(0, Math.round((nowMs - row.stoppedAtMs!) / 1000))}s ago`)
      : null,
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
