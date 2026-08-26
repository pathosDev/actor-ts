import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALL_PANELS_ACTIVE,
  FAKE_TAP_PROVIDERS,
  FakeTapSocket,
  fakeWelcome,
} from '../../app/testing/fakeTapSocket.js';
import { installDomGaps } from '../../app/testing/domGaps.js';
import { TapClientService } from '../../app/TapClientService.js';
import { DashboardPanelComponent } from './DashboardPanelComponent.js';
import type { NodeFigures, StatsSamplePayload } from '../../../../src/devtools/protocol/index.js';

/**
 * The overview against a node that cannot read its own metrics (#744).
 *
 * Three of this panel's figures come from the `MetricsRegistry` —
 * `messagesProcessed`, `mailboxDrops` and `handlerLatency` — and a registry
 * that writes through to a foreign collector keeps no snapshot to read back.
 * The node then reports those three as a steady zero, which on a busy system
 * is not merely wrong but reassuring, and one of them is the framework's own
 * overload signal.
 *
 * The tiles answer that with a dash.  The charts are the part that had not:
 * "Throughput" plots `messages / s` from the very counter the tile beside it
 * refuses to show, so the same page said "no reading" in one place and drew a
 * flat line at zero in the other — and a flat line at zero is a claim, not an
 * absence.  Everything here is about the difference between those two.
 *
 * The samples below are what a blind node genuinely sends: `messagesProcessed`
 * pinned at 0 forever, `deadLetters` climbing.  Dead letters are counted off
 * the event stream rather than the registry, which is why they must survive —
 * a chart that blanked itself would throw away the one honest series on it,
 * and it is the series you want during exactly the incident this flag appears
 * in.
 */

/** Wall-clock origin of the fake series; the value itself means nothing. */
const FIRST_SAMPLE_MS = 1_700_000_000_000;

/** Dead letters per sample — the honest series, and deliberately not zero. */
const DEAD_LETTERS_PER_SAMPLE = 2;

/** Messages per sample on a node that CAN read its registry. */
const MESSAGES_PER_SAMPLE = 500;

/**
 * One sample, `index` seconds after the first.
 *
 * A blind node reports `messagesProcessed: 0` rather than omitting it —
 * `counterTotal` over an empty snapshot is 0 — so the flat line is what the
 * panel actually receives.  Reproducing that faithfully matters: a test that
 * fed a *missing* counter would prove the panel handles a case the server
 * never produces.
 */
function sample(index: number, blind: boolean): StatsSamplePayload {
  const atMs = FIRST_SAMPLE_MS + index * 1000;
  const figures: NodeFigures = {
    address: 'local',
    systemName: 'test-system',
    uptimeMs: index * 1000,
    actorCount: 12,
    actorsStarted: 12,
    actorsStopped: 0,
    actorsRestarted: 0,
    deadLetters: index * DEAD_LETTERS_PER_SAMPLE,
    messagesProcessed: blind ? 0 : index * MESSAGES_PER_SAMPLE,
    mailboxDrops: 0,
    mailboxBacklog: 3,
    stashedTotal: 0,
    suspendedActors: 0,
    topMailboxes: [],
    ...(blind ? { metricsUnavailable: true } : {}),
  };

  return {
    kind: 'stats-sample',
    atMs,
    uptimeMs: figures.uptimeMs,
    runtime: 'bun',
    actorCount: figures.actorCount,
    actorsStarted: figures.actorsStarted,
    actorsStopped: figures.actorsStopped,
    actorsRestarted: figures.actorsRestarted,
    deadLetters: figures.deadLetters,
    messagesProcessed: figures.messagesProcessed,
    mailboxDrops: figures.mailboxDrops,
    mailboxBacklog: figures.mailboxBacklog,
    stashedTotal: figures.stashedTotal,
    suspendedActors: figures.suspendedActors,
    ...(blind ? { metricsUnavailable: true } : {}),
    topMailboxes: [],
    nodes: [{ figures, receivedAtMs: atMs, stale: false, isSelf: true }],
  };
}

describe('DashboardPanelComponent', () => {
  let fixture: ComponentFixture<DashboardPanelComponent>;
  let nextFrame = 0;

  function mount(): void {
    TestBed.configureTestingModule({
      imports: [DashboardPanelComponent],
      providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
    });
    TestBed.inject(TapClientService);
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture = TestBed.createComponent(DashboardPanelComponent);
    fixture.detectChanges();
  }

  /**
   * Push one `stats` payload, carrying the stream sequence the client checks.
   *
   * Omitting the sequence is not a shortcut: `tapClient` stores
   * `sequenceNumber + 1` as what it expects next, so an absent number makes
   * that NaN and every frame after the first reads as a gap.
   */
  function push(payload: StatsSamplePayload): void {
    FakeTapSocket.latest.receives({
      kind: 'event', stream: 'stats', sequenceNumber: nextFrame++, payload,
    });
    fixture.detectChanges();
  }

  /**
   * Two samples, which is the fewest that produce a rate — and therefore the
   * fewest that draw anything at all.
   */
  function stream(blind: boolean): void {
    push(sample(1, blind));
    push(sample(2, blind));
  }

  /** The "Throughput" block, which is the one fed by the registry. */
  function throughput() {
    const block = fixture.componentInstance.charts()[0];
    if (block === undefined) throw new Error('the overview drew no charts');
    if (block.title !== 'Throughput') throw new Error(`first chart is ${block.title}`);
    return block;
  }

  /**
   * The names ECharts is actually handed.
   *
   * Asserted alongside the legend rather than instead of it: the legend is
   * markup the panel writes by hand, so a legend-only assertion would pass
   * against a chart that dropped the label and kept plotting the data.
   */
  function plottedSeries(): string[] {
    const option = throughput().option as unknown as { series?: ReadonlyArray<{ name?: string }> };
    return (option.series ?? []).map((entry) => entry.name ?? '');
  }

  /** Every legend entry of the Throughput chart that stands for a drawn line. */
  function legendLines(): string[] {
    const chart = (fixture.nativeElement as HTMLElement).querySelector('.dt-chart');
    if (chart === null) throw new Error('no chart section rendered');
    return Array.from(chart.querySelectorAll('.dt-legend__item'))
      .map((entry) => (entry.textContent ?? '').trim());
  }

  function chartText(): string {
    const chart = (fixture.nativeElement as HTMLElement).querySelector('.dt-chart');
    if (chart === null) throw new Error('no chart section rendered');
    return chart.textContent ?? '';
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
    nextFrame = 0;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('plots messages / s while the registry can be read', () => {
    // The contrast, asserted first so the case below is a real difference
    // rather than a test a chart with no lines at all would also satisfy.
    mount();
    stream(false);

    expect(throughput().lines.map((line) => line.label)).toContain('messages / s');
    expect(plottedSeries()).toContain('messages / s');
    expect(legendLines()).toContain('messages / s');
  });

  it('draws no messages / s line when the node cannot read its metrics', () => {
    // THE point. The counter behind this line is the one the tile beside it
    // shows as a dash, and a line drawn from it is the same lie in a shape
    // that reads as evidence.
    mount();
    stream(true);

    expect(throughput().lines.map((line) => line.label)).not.toContain('messages / s');
    expect(plottedSeries()).not.toContain('messages / s');
    expect(legendLines()).not.toContain('messages / s');
  });

  it('keeps the dead-letter line, which the event stream still counts', () => {
    // Blanking the whole chart would hide a series that is true, and this is
    // the one an operator reaches for while diagnosing the incident that put
    // the flag there in the first place.
    mount();
    stream(true);

    expect(plottedSeries()).toContain('dead letters / s');
    expect(legendLines()).toContain('dead letters / s');
  });

  it('says which series it left out rather than dropping it silently', () => {
    // A chart that quietly loses a line reads as a rendering fault to anyone
    // who knows the panel. Naming the omission is what turns a missing line
    // into a reading.
    mount();
    stream(true);

    expect(chartText()).toContain('messages / s');
    expect(chartText()).toContain('unavailable');
  });

  it('leaves the charts that never touch the registry alone', () => {
    // Actors and Backlog come from the actor tree, which is read directly and
    // stays correct. Suppressing them would be the mirror of the defect.
    mount();
    stream(true);

    const titles = fixture.componentInstance.charts().map((block) => block.title);
    expect(titles).toEqual(['Throughput', 'Actors', 'Backlog']);

    const drawn = fixture.componentInstance.charts()
      .filter((block) => block.title !== 'Throughput')
      .flatMap((block) => block.lines.map((line) => line.label));
    expect(drawn).toEqual(['actors', 'suspended', 'mailbox backlog', 'stashed']);
  });

  it('dashes the three figures it cannot read and says so once, up top', () => {
    // The half of #744 that already shipped, pinned here so the panel and the
    // charts above cannot drift into disagreeing about the same flag.
    mount();
    stream(true);

    expect(text()).toContain('unavailable');
    const tiles = fixture.componentInstance.numberTiles();
    const valueOf = (label: string): string | undefined =>
      tiles.find((tile) => tile.label === label)?.value;
    expect(valueOf('Messages / s')).toBe('—');
    expect(valueOf('Processed messages')).toBe('—');
    expect(valueOf('Mailbox drops')).toBe('—');
    expect(valueOf('Handler p99')).toBe('—');
    // Read from the actor tree, so it keeps its number.
    expect(valueOf('Actors')).toBe('12');
  });
});
