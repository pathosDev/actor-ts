import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { match } from 'ts-pattern';

import { TapClientService } from '../../app/TapClientService.js';
import { formatCount, formatDuration } from '../../core/format.js';
import { currentTheme } from '../../core/theme.js';
import { themeColor } from '../../render/timeseries.js';
import {
  PROFILE_ROW_HEIGHT,
  buildProfileTree,
  hitTestProfile,
  hottestLeaves,
  layoutProfile,
  profileDepth,
  type ProfileNode,
  type ProfileRectangle,
  type WeightedStack,
} from '../../render/profileTree.js';
import type {
  ProfilerCapabilitiesResult,
  ProfilerMode,
  ProfilerProgressPayload,
  ProfilerStartResult,
  ProfilerStopResult,
} from '../../../../src/devtools/protocol/index.js';

/** Shape the wallclock profile carries alongside the speedscope document. */
type ActorTsProfileExtras = {
  readonly buckets: ReadonlyArray<{
    readonly actorPath: string;
    readonly className: string;
    readonly messageType: string;
    readonly count: number;
    readonly totalMs: number;
    readonly errors: number;
  }>;
};

/** Rows in the "heaviest handlers" table. */
const HOTTEST_LIMIT = 15;

/** Handler times are usually sub-millisecond; show enough digits. */
function formatMilliseconds(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  return `${(value * 1000).toFixed(0)} µs`;
}

function prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (context === null) return null;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || PROFILE_ROW_HEIGHT;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

/**
 * The profiler panel (#226) — where does the actor system spend time?
 *
 * Run a session, get an aggregated flame graph of actor paths and message
 * types, plus the heaviest handlers as a table.  The profile is also
 * downloadable: wallclock runs export speedscope JSON, CPU runs a
 * `.cpuprofile` that Chrome DevTools opens directly.
 *
 * `profileTree.ts` is untouched — the tree building, the layout and the hit
 * test are its job and are tested.  What lives here is the painting and the
 * pointer handling, which stay imperative because that is what a canvas is.
 */
@Component({
  selector: 'devtools-profiler-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="dt-panel__title">Profiler</h1>
    <p class="dt-panel__subtitle">
      Sample where the actor system spends its time. Wallclock groups by actor path and
      message type; CPU hands back a V8 profile for Chrome DevTools.
    </p>

    <div class="dt-toolbar">
      <select
        class="dt-input"
        aria-label="Profiling mode"
        [disabled]="running()"
        (change)="onMode($event)"
      >
        <option value="wallclock" [selected]="mode() === 'wallclock'">
          Wallclock — per actor and message
        </option>
        <!-- Greyed out with the reason in the label, rather than letting Start
             fail: on Bun the inspector module imports fine and throws only when
             a session is constructed, so without asking first the reader meets a
             runtime's internal error message. -->
        <option value="cpu" [selected]="mode() === 'cpu'" [disabled]="!cpuAvailable()">
          {{ cpuLabel() }}
        </option>
      </select>

      <button class="dt-iconbutton" type="button" (click)="onToggle()">
        {{ running() ? 'Stop profiling' : 'Start profiling' }}
      </button>
      <button class="dt-iconbutton" type="button" [disabled]="result() === null" (click)="onDownload()">
        Download
      </button>
      <span class="dt-toolbar__summary">{{ summary() }}</span>
    </div>

    @if (error(); as message) {
      <div class="dt-notice">
        <div class="dt-notice__title">Profiling failed</div>
        <div>{{ message }}</div>
      </div>
    }

    <canvas class="dt-flame" #flame (mousemove)="onMove($event)" (mouseleave)="onLeave()"></canvas>

    <div class="dt-spandetails">
      @if (isCpuProfile()) {
        <div class="dt-notice">
          <div class="dt-notice__title">CPU profile captured</div>
          <div>
            V8 profiles are not rendered here — download it and open the .cpuprofile in
            Chrome DevTools, which does it better than we would.
          </div>
        </div>
      } @else if (focused(); as node) {
        <dl class="dt-kv">
          <dt>Frame</dt><dd [title]="node.key">{{ node.name }}</dd>
          <dt>Total</dt><dd>{{ millis(node.totalMs) }} ({{ share().toFixed(1) }} %)</dd>
          <dt>Self</dt><dd>{{ millis(node.selfMs) }}</dd>
          <dt>Messages</dt><dd>{{ count(node.count) }}</dd>
          <dt>Mean</dt><dd>{{ node.count === 0 ? '—' : millis(node.totalMs / node.count) }}</dd>
          @if (node.errors > 0) {
            <dt>Errors</dt><dd>{{ count(node.errors) }}</dd>
          }
        </dl>
      } @else {
        <p class="dt-empty">
          {{ running() ? 'Profiling… stop to see the result.' : 'Start a session to profile the system.' }}
        </p>
      }
    </div>

    <h2 class="dt-section">Heaviest handlers</h2>
    <div class="dt-hotlist">
      @if (isCpuProfile()) {
        <!-- nothing to tabulate: the V8 profile is not folded here -->
      } @else if (tree() === null) {
        <p class="dt-empty">No profile yet.</p>
      } @else if (leaves().length === 0) {
        <p class="dt-empty">The system handled no messages while profiling.</p>
      } @else {
        @for (leaf of leaves(); track leaf.key) {
          <div class="dt-hotrow" [title]="leaf.key">
            <span class="dt-hotrow__name">{{ leaf.name }}</span>
            <span class="dt-hotrow__bar">
              <span
                class="dt-hotrow__fill"
                [style.width.%]="leaf.percent"
                [style.background]="leaf.errors > 0 ? 'var(--dt-state-error)' : 'var(--dt-data-3)'"
              ></span>
            </span>
            <span class="dt-hotrow__value">{{ millis(leaf.selfMs) }}</span>
          </div>
        }
      }
    </div>
  `,
})
export class ProfilerPanelComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly flame = viewChild.required<ElementRef<HTMLCanvasElement>>('flame');

  readonly mode = signal<ProfilerMode>('wallclock');
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<ProfilerStopResult | null>(null);
  readonly tree = signal<ProfileNode | null>(null);
  readonly hovered = signal<ProfileNode | null>(null);

  readonly cpuAvailable = signal(true);
  readonly cpuLabel = signal('CPU — V8 profile');

  private readonly progress = signal('');
  /** Bumped on resize: a canvas keeps its backing store until told otherwise. */
  private readonly viewport = signal(0);

  private rectangles: readonly ProfileRectangle[] = [];

  readonly isCpuProfile = computed(() => this.result()?.format === 'cpuprofile');

  /** Hovered frame, else the root — the details pane always says something. */
  readonly focused = computed(() => this.hovered() ?? this.tree());

  readonly share = computed(() => {
    const root = this.tree();
    const node = this.focused();
    return root !== null && node !== null && root.totalMs > 0 ? (node.totalMs / root.totalMs) * 100 : 0;
  });

  readonly summary = computed(() => {
    if (this.running()) return this.progress();
    const result = this.result();
    return result === null
      ? ''
      : `${formatCount(result.sampleCount)} messages over `
        + formatDuration(result.stoppedAtMs - result.startedAtMs);
  });

  readonly leaves = computed(() => {
    const root = this.tree();
    if (root === null) return [];
    const hottest = hottestLeaves(root, HOTTEST_LIMIT);
    const peak = hottest[0]?.selfMs || 1;
    return hottest.map((leaf) => ({ ...leaf, percent: (leaf.selfMs / peak) * 100 }));
  });

  constructor() {

    const onResize = (): void => this.viewport.update((value) => value + 1);
    window.addEventListener('resize', onResize);
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));

    this.destroyRef.onDestroy(this.tap.listen('profiler', (payload) => {
      match(payload)
        .with({ kind: 'profiler-progress' }, (p) => this.onProfilerProgress(p))
        .with({ kind: 'profiler-completed' }, () => this.onProfilerCompleted())
        .otherwise(() => this.onUnknownProfilerPayload());
    }));

    this.destroyRef.onDestroy(() => {
      // Never leave an observer on the dispatch path because a tab was closed;
      // the server also clears it on detach.
      if (this.running()) {
        void this.tap.request('profiler.stop').catch(() => { /* already stopped */ });
      }
    });

    afterRenderEffect(() => {
      this.tree();
      this.hovered();
      currentTheme();
      this.viewport();
      this.isCpuProfile();
      this.draw();
    });

    void this.applyCapabilities();
  }

  count(value: number): string { return formatCount(value); }
  millis(value: number): string { return formatMilliseconds(value); }

  onMode(event: Event): void {
    this.mode.set((event.target as HTMLSelectElement).value as ProfilerMode);
  }

  async onToggle(): Promise<void> {
    this.error.set(null);
    try {
      if (this.running()) {
        this.result.set(await this.tap.request<ProfilerStopResult>('profiler.stop'));
        this.running.set(false);
        this.rebuild();
        return;
      }
      this.result.set(null);
      this.tree.set(null);
      await this.tap.request<ProfilerStartResult>('profiler.start', { mode: this.mode() });
      this.running.set(true);
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
      this.running.set(false);
    }
  }

  onDownload(): void {
    const result = this.result();
    if (result === null) return;
    const extension = result.format === 'cpuprofile' ? 'cpuprofile' : 'speedscope.json';
    const blob = new Blob([JSON.stringify(result.profile)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${result.sessionId}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  onMove(event: MouseEvent): void {
    const canvas = this.flame().nativeElement;
    const bounds = canvas.getBoundingClientRect();
    const found = hitTestProfile(this.rectangles, event.clientX - bounds.left, event.clientY - bounds.top);
    this.hovered.set(found?.node ?? null);
  }

  onLeave(): void { this.hovered.set(null); }

  /**
   * Grey out a mode this host cannot run, with the reason in its label.
   */
  private async applyCapabilities(): Promise<void> {
    let capabilities: ProfilerCapabilitiesResult;
    try {
      capabilities = await this.tap.request<ProfilerCapabilitiesResult>('profiler.capabilities');
    } catch {
      return; // An older server: leave every mode offered, as before.
    }
    for (const capability of capabilities.modes) {
      if (capability.mode !== 'cpu') continue;
      this.cpuAvailable.set(capability.available);
      this.cpuLabel.set(capability.available
        ? 'CPU — V8 profile'
        : `CPU — unavailable (${capability.reason ?? 'no inspector here'})`);
      // Never leave an unusable mode selected.
      if (!capability.available && this.mode() === 'cpu') this.mode.set('wallclock');
    }
  }

  private rebuild(): void {
    this.tree.set(null);
    const result = this.result();
    if (result === null || result.format !== 'speedscope') return;
    const extras = (result.profile as { actorTs?: ActorTsProfileExtras } | null)?.actorTs;
    if (extras === undefined) return;
    const stacks: WeightedStack[] = extras.buckets.map((bucket) => ({
      frames: [
        ...bucket.actorPath.replace(/^actor-ts:\/\/[^/]*/, '').split('/').filter((s) => s.length > 0),
        `${bucket.messageType} (${bucket.className})`,
      ],
      weightMs: bucket.totalMs,
      count: bucket.count,
      errors: bucket.errors,
    }));
    this.tree.set(buildProfileTree(stacks));
  }

  private draw(): void {
    const canvas = this.flame().nativeElement;
    const tree = this.tree();
    if (tree === null || this.isCpuProfile()) {
      this.rectangles = [];
      canvas.style.height = `${PROFILE_ROW_HEIGHT}px`;
      prepare(canvas);
      return;
    }
    if (prepare(canvas) === null) return;
    this.rectangles = layoutProfile(tree, canvas.clientWidth || 600);
    canvas.style.height = `${profileDepth(this.rectangles) * PROFILE_ROW_HEIGHT}px`;
    // Re-prepare: changing the CSS height invalidates the backing store.
    const painter = prepare(canvas);
    if (painter === null) return;

    const border = themeColor('--dt-bg', '#0f172a');
    const label = themeColor('--dt-text-strong', '#f1f5f9');
    const hovered = this.hovered();
    painter.font = '11px ui-monospace, monospace';
    painter.textBaseline = 'middle';

    for (const rectangle of this.rectangles) {
      painter.fillStyle = rectangle.node.errors > 0
        ? themeColor('--dt-state-error', '#ef4444')
        : themeColor(`--dt-data-${(rectangle.node.depth % 8) + 1}`, '#818cf8');
      painter.globalAlpha = hovered === null || hovered === rectangle.node ? 1 : 0.5;
      painter.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
      painter.globalAlpha = 1;
      painter.strokeStyle = border;
      painter.lineWidth = 1;
      painter.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);

      if (rectangle.width > 42) {
        painter.save();
        painter.beginPath();
        painter.rect(rectangle.x + 3, rectangle.y, rectangle.width - 6, rectangle.height);
        painter.clip();
        painter.fillStyle = label;
        painter.fillText(rectangle.node.name, rectangle.x + 5, rectangle.y + rectangle.height / 2);
        painter.restore();
      }
    }
  }

  private onProfilerProgress(payload: ProfilerProgressPayload): void {
    this.progress.set(
      `${formatCount(payload.sampleCount)} messages · ${formatDuration(payload.elapsedMs)}`,
    );
  }

  /**
   * The session auto-stopped on its duration; collect the result.  Guarded on
   * `running` because a user-initiated stop already collected it, and the
   * second `profiler.stop` would fail.
   */
  private onProfilerCompleted(): void {
    if (!this.running()) return;
    void (async () => {
      try {
        this.result.set(await this.tap.request<ProfilerStopResult>('profiler.stop'));
      } catch {
        /* already collected */
      }
      this.running.set(false);
      this.rebuild();
    })();
  }

  private onUnknownProfilerPayload(): void {}
}

/** The registry loads this module and reads this export. */
export const panelComponent = ProfilerPanelComponent;
