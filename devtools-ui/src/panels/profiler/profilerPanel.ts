/**
 * The profiler panel (#226) — where does the actor system spend time?
 *
 * Run a session, get an aggregated flame graph of actor paths and
 * message types, plus the heaviest handlers as a table.  The profile is
 * also downloadable: wallclock runs export speedscope JSON, CPU runs a
 * `.cpuprofile` that Chrome DevTools opens directly.
 */
import { h, replaceChildren } from '../../core/dom.js';
import { formatCount, formatDuration } from '../../core/format.js';
import { signal } from '../../core/signal.js';
import { currentTheme } from '../../core/theme.js';
import { effect } from '../../core/signal.js';
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
import type { PanelContext, PanelInstance } from '../../shell/PanelRegistry.js';
import type {
  ProfilerCapabilitiesResult,
  ProfilerMode,
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

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  const mode = signal<ProfilerMode>('wallclock');
  const running = signal(false);
  const error = signal<string | null>(null);
  const progress = signal<string>('');
  let result: ProfilerStopResult | null = null;
  let tree: ProfileNode | null = null;
  let rectangles: ReadonlyArray<ProfileRectangle> = [];
  let hovered: ProfileNode | null = null;

  const wallclockOption = h('option', { value: 'wallclock' }, 'Wallclock — per actor and message');
  const cpuOption = h('option', { value: 'cpu' }, 'CPU — V8 profile') as HTMLOptionElement;

  const modeChooser = h('select', {
    class: 'dt-input',
    'aria-label': 'Profiling mode',
    onchange: (event: Event) => {
      mode.set((event.target as HTMLSelectElement).value as ProfilerMode);
    },
  }, wallclockOption, cpuOption) as HTMLSelectElement;

  /**
   * Grey out a mode this host cannot run, with the reason in its label.
   *
   * Better than letting Start fail: on Bun `node:inspector` imports fine
   * and throws only when a session is constructed, so without asking
   * first the user meets a runtime's internal error message.
   */
  async function applyCapabilities(): Promise<void> {
    let capabilities: ProfilerCapabilitiesResult;
    try {
      capabilities = await context.tap.request<ProfilerCapabilitiesResult>('profiler.capabilities');
    } catch {
      return;   // An older server: leave every mode offered, as before.
    }
    for (const capability of capabilities.modes) {
      if (capability.mode !== 'cpu') continue;
      cpuOption.disabled = !capability.available;
      cpuOption.textContent = capability.available
        ? 'CPU — V8 profile'
        : `CPU — unavailable (${capability.reason ?? 'no inspector here'})`;
      // Never leave an unusable mode selected.
      if (!capability.available && mode.get() === 'cpu') {
        mode.set('wallclock');
        modeChooser.value = 'wallclock';
      }
    }
  }

  const runButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => void toggle(),
  }, 'Start profiling');

  const downloadButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => download(),
  }, 'Download');

  const summary = h('span', { class: 'dt-toolbar__summary' });
  const notice = h('div', {});
  const canvas = h('canvas', { class: 'dt-flame' }) as HTMLCanvasElement;
  const details = h('div', { class: 'dt-spandetails' });
  const table = h('div', { class: 'dt-hotlist' });

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Profiler'),
    h('p', { class: 'dt-panel__subtitle' },
      'Sample where the actor system spends its time. Wallclock groups by actor path and '
      + 'message type; CPU hands back a V8 profile for Chrome DevTools.'),
    h('div', { class: 'dt-toolbar' }, modeChooser, runButton, downloadButton, summary),
    notice,
    canvas,
    details,
    h('h2', { class: 'dt-section' }, 'Heaviest handlers'),
    table,
  );

  async function toggle(): Promise<void> {
    error.set(null);
    try {
      if (running.get()) {
        result = await context.tap.request<ProfilerStopResult>('profiler.stop');
        running.set(false);
        rebuild();
      } else {
        result = null;
        tree = null;
        await context.tap.request<ProfilerStartResult>('profiler.start', { mode: mode.get() });
        running.set(true);
      }
    } catch (cause) {
      error.set((cause as Error).message);
      running.set(false);
    }
    render();
  }

  function rebuild(): void {
    tree = null;
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
    tree = buildProfileTree(stacks);
  }

  function draw(): void {
    const context2d = prepare(canvas);
    if (context2d === null || tree === null) {
      rectangles = [];
      canvas.style.height = `${PROFILE_ROW_HEIGHT}px`;
      return;
    }
    rectangles = layoutProfile(tree, canvas.clientWidth || 600);
    canvas.style.height = `${profileDepth(rectangles) * PROFILE_ROW_HEIGHT}px`;
    // Re-prepare: changing the CSS height invalidates the backing store.
    const painter = prepare(canvas);
    if (painter === null) return;

    const border = themeColor('--dt-bg', '#0f172a');
    const label = themeColor('--dt-text-strong', '#f1f5f9');
    painter.font = '11px ui-monospace, monospace';
    painter.textBaseline = 'middle';

    for (const rectangle of rectangles) {
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

  function renderDetails(): void {
    const node = hovered ?? tree;
    if (node === null) {
      replaceChildren(details, h('p', { class: 'dt-empty' },
        running.get()
          ? 'Profiling… stop to see the result.'
          : 'Start a session to profile the system.'));
      return;
    }
    const share = tree !== null && tree.totalMs > 0 ? (node.totalMs / tree.totalMs) * 100 : 0;
    replaceChildren(details, h('dl', { class: 'dt-kv' },
      h('dt', {}, 'Frame'), h('dd', { title: node.key }, node.name),
      h('dt', {}, 'Total'), h('dd', {}, `${formatMilliseconds(node.totalMs)} (${share.toFixed(1)} %)`),
      h('dt', {}, 'Self'), h('dd', {}, formatMilliseconds(node.selfMs)),
      h('dt', {}, 'Messages'), h('dd', {}, formatCount(node.count)),
      h('dt', {}, 'Mean'), h('dd', {},
        node.count === 0 ? '—' : formatMilliseconds(node.totalMs / node.count)),
      ...(node.errors > 0 ? [h('dt', {}, 'Errors'), h('dd', {}, formatCount(node.errors))] : []),
    ));
  }

  function renderTable(): void {
    if (tree === null) {
      replaceChildren(table, h('p', { class: 'dt-empty' }, 'No profile yet.'));
      return;
    }
    const leaves = hottestLeaves(tree, HOTTEST_LIMIT);
    if (leaves.length === 0) {
      replaceChildren(table, h('p', { class: 'dt-empty' },
        'The system handled no messages while profiling.'));
      return;
    }
    const peak = leaves[0]!.selfMs || 1;
    replaceChildren(table, ...leaves.map((leaf) => h('div', { class: 'dt-hotrow', title: leaf.key },
      h('span', { class: 'dt-hotrow__name' }, leaf.name),
      h('span', { class: 'dt-hotrow__bar' },
        h('span', {
          class: 'dt-hotrow__fill',
          style: `width:${(leaf.selfMs / peak) * 100}%`
            + `;background:${leaf.errors > 0 ? 'var(--dt-state-error)' : 'var(--dt-data-3)'}`,
        }),
      ),
      h('span', { class: 'dt-hotrow__value' }, formatMilliseconds(leaf.selfMs)),
    )));
  }

  function render(): void {
    runButton.textContent = running.get() ? 'Stop profiling' : 'Start profiling';
    modeChooser.toggleAttribute('disabled', running.get());
    (downloadButton as HTMLButtonElement).disabled = result === null;

    summary.textContent = running.get()
      ? progress.get()
      : result === null
        ? ''
        : `${formatCount(result.sampleCount)} messages over `
          + formatDuration(result.stoppedAtMs - result.startedAtMs);

    const message = error.get();
    replaceChildren(notice, message === null ? null : h('div', { class: 'dt-notice' },
      h('div', { class: 'dt-notice__title' }, 'Profiling failed'),
      h('div', {}, message),
    ));

    if (result !== null && result.format === 'cpuprofile') {
      replaceChildren(details, h('div', { class: 'dt-notice' },
        h('div', { class: 'dt-notice__title' }, 'CPU profile captured'),
        h('div', {}, 'V8 profiles are not rendered here — download it and open the '
          + '.cpuprofile in Chrome DevTools, which does it better than we would.'),
      ));
      replaceChildren(table);
      canvas.style.height = `${PROFILE_ROW_HEIGHT}px`;
      prepare(canvas);
      return;
    }

    draw();
    renderDetails();
    renderTable();
  }

  function download(): void {
    if (result === null) return;
    const extension = result.format === 'cpuprofile' ? 'cpuprofile' : 'speedscope.json';
    const blob = new Blob([JSON.stringify(result.profile)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `${result.sessionId}.${extension}` });
    link.click();
    URL.revokeObjectURL(url);
  }

  canvas.addEventListener('mousemove', (event) => {
    const bounds = canvas.getBoundingClientRect();
    const found = hitTestProfile(rectangles, event.clientX - bounds.left, event.clientY - bounds.top);
    const next = found?.node ?? null;
    if (next === hovered) return;
    hovered = next;
    draw();
    renderDetails();
  });
  canvas.addEventListener('mouseleave', () => {
    hovered = null;
    draw();
    renderDetails();
  });

  const stop = context.tap.listen('profiler', (payload) => {
    if (payload.kind === 'profiler-progress') {
      progress.set(`${formatCount(payload.sampleCount)} messages · ${formatDuration(payload.elapsedMs)}`);
      render();
      return;
    }
    if (payload.kind === 'profiler-completed' && running.get()) {
      // The session auto-stopped on its duration; collect the result.
      void (async () => {
        try {
          result = await context.tap.request<ProfilerStopResult>('profiler.stop');
        } catch {
          /* already collected */
        }
        running.set(false);
        rebuild();
        render();
      })();
    }
  });

  const disposeTheme = effect(render, [currentTheme]);
  const onResize = (): void => render();
  window.addEventListener('resize', onResize);
  render();
  void applyCapabilities();

  return {
    dispose(): void {
      // Never leave an observer on the dispatch path because a tab was
      // closed; the server also clears it on detach.
      if (running.get()) {
        void context.tap.request('profiler.stop').catch(() => { /* already stopped */ });
      }
      stop();
      disposeTheme();
      window.removeEventListener('resize', onResize);
    },
  };
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

/** Handler times are usually sub-millisecond; show enough digits. */
function formatMilliseconds(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  return `${(value * 1000).toFixed(0)} µs`;
}
