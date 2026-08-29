import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_PANELS_ACTIVE,
  FAKE_TAP_PROVIDERS,
  FakeTapSocket,
  fakeWelcome,
} from '../../app/testing/fakeTapSocket.js';
import { installDomGaps } from '../../app/testing/domGaps.js';
import { TapClientService } from '../../app/TapClientService.js';
import { TimeControlService } from '../../app/TimeControlService.js';
import { ActorsPanelComponent } from './ActorsPanelComponent.js';
import type { ActorNode } from '../../../../src/devtools/protocol/index.js';

/**
 * The actors panel, and specifically what a pause has to protect (#1349).
 *
 * A stopped actor stays on screen for thirty seconds and is then swept away.
 * That retention is deliberate — the actor you want to read about is the one
 * that just died — but thirty seconds is well inside the time it takes to read
 * a supervision tree, which is why the pause exists.
 *
 * So the case that matters here is not that data stops arriving. It is that
 * the SWEEP stops: a pause that froze delivery and left the clock running
 * would delete precisely the row the reader paused to study, and would do it
 * quietly, half a minute after they stopped looking at the button.
 */

/** Mirrors `STOPPED_RETENTION_MS` in the component. */
const RETENTION_MS = 30_000;
const NODE = 'local';
const DOOMED = 'actor-ts://test/user/doomed';

let nextFrame = 0;

function actor(path: string, overrides: Partial<ActorNode> = {}): ActorNode {
  const segments = path.split('/');
  return {
    nodeAddress: NODE,
    path,
    parentPath: null,
    name: segments[segments.length - 1] ?? path,
    className: 'DoomedActor',
    displayName: null,
    cellState: 'running',
    mailboxSize: 0,
    stashSize: 0,
    suspended: false,
    dispatcher: null,
    childCount: 0,
    internal: false,
    ...overrides,
  };
}

describe('ActorsPanelComponent', () => {
  let fixture: ComponentFixture<ActorsPanelComponent>;
  let time: TimeControlService;

  function mount(): void {
    TestBed.configureTestingModule({
      imports: [ActorsPanelComponent],
      providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
    });
    TestBed.inject(TapClientService);
    time = TestBed.inject(TimeControlService);
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture = TestBed.createComponent(ActorsPanelComponent);
    fixture.detectChanges();
  }

  /**
   * Push one `actors` payload, carrying the stream sequence the client checks.
   *
   * Omitting the sequence is not a shortcut: `tapClient` stores
   * `sequenceNumber + 1` as what it expects next, so an absent number makes
   * that NaN and every frame after the first reads as a gap.
   */
  function push(payload: unknown): void {
    FakeTapSocket.latest.receives({
      kind: 'event', stream: 'actors', sequenceNumber: nextFrame++, payload,
    });
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function rows(): HTMLElement[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.dt-tree__row'));
  }

  /**
   * Tombstone rows, by their own class.
   *
   * Not by searching the text for "stopped": the toolbar carries the label
   * "Keep stopped for 30s" at all times, so a text assertion is true whether
   * the row is there or not — it would pass against a panel that swept
   * everything away, which is the exact failure these tests exist to catch.
   */
  function stoppedRows(): HTMLElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.dt-tree__row--stopped'),
    );
  }

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
    nextFrame = 0;
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  /** A tree with one actor in it, already marked stopped. */
  function tombstone(): void {
    push({ kind: 'actor-tree-snapshot', atMs: Date.now(), actors: [actor(DOOMED)] });
    push({ kind: 'actor-stopped', atMs: Date.now(), nodeAddress: NODE, path: DOOMED });
    expect(stoppedRows()).toHaveLength(1);
    expect(text()).toContain('stopped 0s ago');
  }

  it('sweeps a tombstone away once its retention has passed', () => {
    // The behaviour the pause has to suspend. Asserted first so the case below
    // is a real contrast rather than a test that would pass either way.
    mount();
    tombstone();

    vi.advanceTimersByTime(RETENTION_MS + 1_000);
    fixture.detectChanges();
    expect(rows()).toHaveLength(0);
  });

  it('keeps a tombstone past its retention while time is paused', () => {
    // THE point of the feature. A pause that only froze delivery would still
    // fail this, because nothing arriving is not what removes the row — the
    // sweeper running against the wall clock is.
    mount();
    tombstone();

    time.pause();
    vi.advanceTimersByTime(RETENTION_MS * 3);
    fixture.detectChanges();

    expect(stoppedRows()).toHaveLength(1);
  });

  it('holds the age reading still rather than counting up beside a frozen row', () => {
    // A badge ticking upward over a view that is not moving says the row is
    // live. It is the opposite: the row is being held precisely because it is
    // not.
    mount();
    tombstone();

    time.pause();
    vi.advanceTimersByTime(12_000);
    fixture.detectChanges();
    expect(text()).toContain('stopped 0s ago');
  });

  it('does not sweep as a side effect of collapsing a node while paused', () => {
    // `touch` has a second caller. Leaving the guard to the sweeper alone would
    // mean a click that was only ever about folding the tree collected every
    // tombstone on screen as a side effect.
    //
    // Collapsed and then expanded again, so the assertion cannot be satisfied
    // by the branch simply being hidden: after the second click every row is
    // back on screen, and anything missing was swept rather than folded away.
    mount();
    push({
      kind: 'actor-tree-snapshot',
      atMs: Date.now(),
      actors: [
        actor(DOOMED, { childCount: 1 }),
        actor(`${DOOMED}/child`, { parentPath: DOOMED }),
      ],
    });
    push({ kind: 'actor-stopped', atMs: Date.now(), nodeAddress: NODE, path: DOOMED });
    expect(stoppedRows()).toHaveLength(2);

    time.pause();
    vi.advanceTimersByTime(RETENTION_MS * 2);

    function twisty(): HTMLButtonElement {
      const found = (fixture.nativeElement as HTMLElement)
        .querySelector('.dt-tree__twisty:not(.dt-tree__twisty--leaf)');
      if (found === null) throw new Error('the parent row has no twisty');
      return found as HTMLButtonElement;
    }

    twisty().click();
    fixture.detectChanges();
    twisty().click();
    fixture.detectChanges();

    expect(stoppedRows()).toHaveLength(2);
  });

  it('shows the current tree again once time runs, tombstone and all', () => {
    // Resuming means "jump to now". The server answers the re-subscribe with a
    // fresh snapshot, and `ActorTreeModel.reset` clears tombstones because a
    // snapshot describes only living actors — so the held row goes when the
    // truth arrives, not before.
    mount();
    tombstone();

    time.pause();
    vi.advanceTimersByTime(RETENTION_MS * 2);
    time.resume();
    TestBed.tick();

    push({
      kind: 'actor-tree-snapshot',
      atMs: Date.now(),
      actors: [actor('actor-ts://test/user/survivor', { className: 'SurvivorActor' })],
    });

    expect(text()).toContain('SurvivorActor');
    expect(stoppedRows()).toHaveLength(0);
    expect(rows()).toHaveLength(1);
  });
});
