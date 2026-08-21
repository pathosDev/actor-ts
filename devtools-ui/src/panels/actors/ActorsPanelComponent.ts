import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { match, P } from 'ts-pattern';

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatDuration } from '../../core/format.js';
import { ActorTreeModel, type TreeRow } from './actorsTree.js';
import type {
  ActorCellState,
  ActorChangedPayload,
  ActorNode,
  ActorNodeTreePayload,
  ActorRestartedPayload,
  ActorStartedPayload,
  ActorStoppedPayload,
  ActorTreeSnapshotPayload,
  MailboxDepthEntry,
} from '../../../../src/devtools/protocol/index.js';

/**
 * How long a stopped actor stays on screen, greyed and red.
 *
 * Long enough to notice and read after the fact — the interesting actor is
 * usually the one that just died — and short enough that a system churning
 * actors does not turn the tree into a graveyard.
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

/** One node's rows, ready to render. */
type NodeGroup = {
  readonly address: string;
  readonly rows: readonly TreeRow[];
  readonly staleSince: number | null;
};

/**
 * The actors panel (#204) — the live tree, with mailbox depths.
 *
 * A DOM list rather than a canvas: the tree needs selection, text search,
 * keyboard access and copyable paths, all of which a canvas would have to
 * reimplement badly.  #486 leaves this one alone for the same reason.
 *
 * `ActorTreeModel` is untouched — the expand state, the tombstones and the
 * filter that keeps a match's ancestors are its job, and they are tested.
 */
@Component({
  selector: 'devtools-actors-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Actors</h1>
    <p class="dt-panel__subtitle">
      The live supervision tree. Depth counts messages waiting in the mailbox.
    </p>

    <div class="dt-toolbar">
      <input
        class="dt-input"
        type="search"
        placeholder="Filter by path, class or name…"
        aria-label="Filter actors"
        [value]="filter()"
        (input)="onFilter($event)"
      />
      <label class="dt-checkbox">
        <input type="checkbox" [checked]="hideInternal()" (change)="onHideInternal($event)" />
        Hide DevTools actors
      </label>
      <label class="dt-checkbox">
        <input type="checkbox" [checked]="showStopped()" (change)="onShowStopped($event)" />
        Keep stopped for {{ retentionSeconds }}s
      </label>
      <span class="dt-toolbar__summary">{{ summary() }}</span>
    </div>

    <div class="dt-tree">
      @if (groups().length === 0) {
        <p class="dt-empty">
          {{ liveCount() === 0 ? 'Waiting for the actor tree…' : 'No actor matches that filter.' }}
        </p>
      } @else {
        @for (group of groups(); track group.address) {
          @if (grouped()) {
            <h3 class="dt-tree__node">
              {{ group.address }}
              <span class="dt-tree__nodecount">{{ count(group.rows.length) }}</span>
              @if (group.staleSince !== null) {
                <span class="dt-badge dt-badge--error">
                  not answering · last seen {{ since(group.staleSince) }} ago
                </span>
              }
            </h3>
          }
          <!-- A node that has stopped answering left a snapshot behind. Its
               actors are not running — nobody knows what they are — so the whole
               group is dimmed and its state dots go neutral rather than reporting
               the green they had when the last tree arrived. -->
          <div class="dt-tree__group" [class.dt-tree__group--stale]="group.staleSince !== null">
            <!-- Tracked by path alone: Angular forbids the outer loop variable
                 here, and paths only collide ACROSS nodes — which is exactly why
                 there is one tree model per node. -->
            @for (row of group.rows; track row.node.path) {
              <div
                class="dt-tree__row"
                [class.dt-tree__row--stopped]="row.stoppedAtMs !== null"
                [style.--dt-tree-depth]="row.depth"
                [title]="row.node.path"
              >
                @if (row.hasChildren) {
                  <button
                    class="dt-tree__twisty"
                    type="button"
                    [attr.aria-label]="row.expanded ? 'Collapse' : 'Expand'"
                    (click)="onToggle(group.address, row.node.path)"
                  >{{ row.expanded ? '▾' : '▸' }}</button>
                } @else {
                  <span class="dt-tree__twisty dt-tree__twisty--leaf"></span>
                }

                <span class="dt-state {{ stateToken(row.node.cellState) }}" [title]="row.node.cellState"></span>
                <!-- The actor's own name when it has one, else the path segment.
                     The full path stays on the row's title either way. -->
                <span class="dt-tree__name">{{ nameOf(row.node) }}</span>
                <span class="dt-tree__class">{{ row.node.className }}</span>

                @if (depthOf(row) > 0) {
                  <span class="dt-badge dt-badge--warn" title="messages waiting">{{ count(depthOf(row)) }}</span>
                }
                @if (row.node.stashSize > 0) {
                  <span class="dt-badge" title="stashed messages">stash {{ count(row.node.stashSize) }}</span>
                }
                @if (row.node.suspended) {
                  <span class="dt-badge dt-badge--error">suspended</span>
                }
                @if (row.stoppedAtMs !== null) {
                  <span class="dt-badge dt-badge--error" title="removed shortly">
                    stopped {{ stoppedFor(row.stoppedAtMs) }}s ago
                  </span>
                }
              </div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class ActorsPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly retentionSeconds = STOPPED_RETENTION_MS / 1000;

  /**
   * One tree per node.  Paths repeat across a cluster — every node runs the same
   * system name, so `/user/orders` exists on all of them — and a single map
   * keyed by path would have them overwrite each other.
   */
  private readonly models = new Map<string, ActorTreeModel>();
  /** Nodes that stopped answering → when they last did. */
  private readonly staleNodes = new Map<string, number>();
  private readonly mailboxes = new Map<string, MailboxDepthEntry>();

  /** Bumped whenever the maps above change, so the computed rows recompute. */
  private readonly revision = signal(0);
  private readonly now = signal(Date.now());

  readonly filter = signal('');
  readonly hideInternal = signal(true);
  readonly showStopped = signal(true);

  private readonly view = computed(() => {
    this.revision();
    const now = this.now();
    const hide = this.hideInternal();
    const keepStopped = this.showStopped();
    const needle = this.filter();

    const groups: NodeGroup[] = [];
    let shown = 0;
    let live = 0;
    let stoppedShown = 0;

    for (const address of [...this.models.keys()].sort()) {
      const model = this.models.get(address)!;
      let rows = model.rows(needle);
      // The server marks its own actors, so this no longer has to guess from
      // names — which missed their children, and a DevTools websocket
      // connection is a child of the DevTools hub.
      if (hide) rows = rows.filter((row) => !row.node.internal);
      if (!keepStopped) rows = rows.filter((row) => row.stoppedAtMs === null);
      live += model.size;
      shown += rows.length;
      stoppedShown += rows.filter((row) => row.stoppedAtMs !== null).length;
      if (rows.length === 0) continue;
      groups.push({ address, rows, staleSince: this.staleNodes.get(address) ?? null });
    }

    return { groups, shown, live, stoppedShown, nodeCount: this.models.size };
  });

  readonly groups = computed(() => this.view().groups);
  readonly liveCount = computed(() => this.view().live);
  readonly grouped = computed(() => this.view().nodeCount > 1);

  /**
   * Tombstones are rows but not population, so they are counted apart rather
   * than inflating "n of m actors" past m.
   */
  readonly summary = computed(() => {
    const { shown, live, stoppedShown, nodeCount } = this.view();
    return `${formatCount(shown - stoppedShown)} of ${formatCount(live)} actors`
      + (nodeCount > 1 ? ` across ${formatCount(nodeCount)} nodes` : '')
      + (stoppedShown > 0 ? ` · ${formatCount(stoppedShown)} recently stopped` : '');
  });

  constructor() {
    this.destroyRef.onDestroy(this.tap.listen('actors', (payload) => {
      // Arms report whether the tree changed; only then is a re-render worth it.
      const changed = match(payload)
        .with({ kind: 'actor-tree-snapshot' }, (p) => this.onActorTreeSnapshot(p))
        .with({ kind: 'actor-node-tree' }, (p) => this.onActorNodeTree(p))
        .with(P.union({ kind: 'actor-started' }, { kind: 'actor-changed' }), (p) => this.onActorUpserted(p))
        .with({ kind: 'actor-stopped' }, (p) => this.onActorStopped(p))
        .with({ kind: 'actor-restarted' }, (p) => this.onActorRestarted(p))
        .otherwise(() => this.onUnknownActorPayload());
      if (changed) this.touch();
    }));

    // Mailbox depths arrive on their own stream so the tree does not have to be
    // re-sent every second just to update a number.
    this.destroyRef.onDestroy(this.tap.listen('mailboxes', (payload) => {
      if (payload.kind !== 'mailbox-sample') return;
      this.mailboxes.clear();
      for (const entry of payload.entries) this.mailboxes.set(entry.path, entry);
      this.touch();
    }));

    // Nothing on the wire says "that row is now old enough to drop", and on an
    // idle system no frame arrives to trigger a render either.  The sweeping
    // itself happens in `touch`, so this tick exists to keep the badges counting
    // up and to drop rows nothing else would — throttling it in a background tab
    // is harmless, because `touch` sweeps against the wall clock rather than
    // against how often it ran.
    const sweeper = setInterval(() => {
      for (const model of this.models.values()) {
        if (model.stoppedCount > 0) { this.touch(); return; }
      }
    }, SWEEP_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(sweeper));
  }

  count(value: number): string { return formatCount(value); }
  since(atMs: number): string { return formatDuration(this.now() - atMs); }
  stateToken(state: ActorCellState): string { return STATE_TOKENS[state]; }
  nameOf(node: ActorNode): string { return node.displayName ?? (node.name === '' ? '/' : node.name); }
  stoppedFor(atMs: number): number { return Math.max(0, Math.round((this.now() - atMs) / 1000)); }

  /**
   * The sampled depth is fresher than the one carried by the tree delta, which
   * was accurate only at spawn time — but a stopped actor is not in the sample
   * any more, so its last known depth is the truth.
   */
  depthOf(row: TreeRow): number {
    return row.stoppedAtMs !== null
      ? row.node.mailboxSize
      : this.mailboxes.get(row.node.path)?.size ?? row.node.mailboxSize;
  }

  onFilter(event: Event): void { this.filter.set((event.target as HTMLInputElement).value); }
  onHideInternal(event: Event): void { this.hideInternal.set((event.target as HTMLInputElement).checked); }
  onShowStopped(event: Event): void { this.showStopped.set((event.target as HTMLInputElement).checked); }

  onToggle(address: string, path: string): void {
    this.models.get(address)?.toggle(path);
    this.touch();
  }

  /**
   * Fold new data in: age out tombstones, then let the view recompute.
   *
   * The sweep happens HERE and not inside the computed, which is where it
   * naturally wants to live — a rendered frame is the moment a tombstone
   * actually stops being worth showing, and a background tab throttles its
   * intervals to about once a minute.  But `sweep` mutates the models, and a
   * `computed` that mutates during evaluation is a side effect: it left the
   * view rendering one update behind, because the mutation happened inside
   * the very computation whose result was being installed.  Sweeping on the
   * way in keeps the timing (every frame, plus the one-second tick) and
   * leaves the computed pure.
   */
  private touch(): void {
    const now = Date.now();
    for (const model of this.models.values()) model.sweep(now, STOPPED_RETENTION_MS);
    this.now.set(now);
    this.revision.update((value) => value + 1);
  }

  private modelFor(address: string): ActorTreeModel {
    const existing = this.models.get(address);
    if (existing !== undefined) return existing;
    const created = new ActorTreeModel();
    this.models.set(address, created);
    return created;
  }

  /** One frame can carry several nodes; each replaces its own tree. */
  private onActorTreeSnapshot(payload: ActorTreeSnapshotPayload): boolean {
    for (const [address, actors] of byNode(payload.actors)) this.modelFor(address).reset(actors);
    return true;
  }

  private onActorNodeTree(payload: ActorNodeTreePayload): boolean {
    this.modelFor(payload.address).applyFullTree(payload.actors, payload.atMs);
    if (payload.stale) this.staleNodes.set(payload.address, payload.receivedAtMs);
    else this.staleNodes.delete(payload.address);
    return true;
  }

  private onActorUpserted(payload: ActorStartedPayload | ActorChangedPayload): boolean {
    this.modelFor(payload.actor.nodeAddress).upsert(payload.actor);
    return true;
  }

  private onActorStopped(payload: ActorStoppedPayload): boolean {
    this.modelFor(payload.nodeAddress).markStopped(payload.path, payload.atMs);
    return true;
  }

  /**
   * The path survives a restart, so nothing structural changes — the row only
   * flashes, and re-rendering the tree would throw the flash away.
   *
   * Still done to the DOM directly, and deliberately: re-adding the class after
   * a forced reflow is what restarts the CSS animation when the same actor
   * restarts twice in quick succession.  Expressed as state, the second flash
   * would be a no-op because the value never changed.
   */
  private onActorRestarted(payload: ActorRestartedPayload): boolean {
    const row = [...this.element.nativeElement.querySelectorAll<HTMLElement>('.dt-tree__row')]
      .find((candidate) => candidate.title === payload.path);
    if (row === undefined) return false;
    row.classList.remove('dt-tree__row--restarted');
    void row.offsetWidth;
    row.classList.add('dt-tree__row--restarted');
    return false;
  }

  private onUnknownActorPayload(): boolean {
    return false;
  }
}

/** Split one snapshot into the trees it actually contains. */
function byNode(actors: ReadonlyArray<ActorNode>): ReadonlyMap<string, ActorNode[]> {
  const out = new Map<string, ActorNode[]>();
  for (const actor of actors) {
    const bucket = out.get(actor.nodeAddress);
    if (bucket === undefined) out.set(actor.nodeAddress, [actor]);
    else bucket.push(actor);
  }
  return out;
}

/** The registry loads this module and reads this export. */
export const panelComponent = ActorsPanelComponent;
