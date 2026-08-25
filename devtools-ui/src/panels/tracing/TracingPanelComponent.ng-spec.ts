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
import { TracingPanelComponent } from './TracingPanelComponent.js';
import type { WireSpan } from '../../../../src/devtools/protocol/index.js';

/**
 * The tracing panel's retained ring, and specifically its identity (#1350).
 *
 * This panel is the one that ACCUMULATES. Every other stream consumer replaces
 * its state when a snapshot arrives — `ActorTreeModel.reset` drops its map,
 * `onClusterSnapshot` calls `members.set(...)` — so a re-subscribe means "here
 * is everything" to them and used to mean "here is more" to this one.
 *
 * That matters because `SpanTap.snapshot()` hands a fresh subscriber the
 * server's WHOLE ring, and two existing paths re-subscribe an already-open
 * stream: the sequence-gap recovery in `tapClient`, and the re-subscribe of
 * every live stream after a reconnect. Both used to draw every retained span
 * twice.
 */

/** Mirrors `TRACING_BUFFER_DEFAULT`, which the panel asks the server for. */
const DEFAULT_CAPACITY = 100;

let nextFrame = 0;

function span(spanId: string, overrides: Partial<WireSpan> = {}): WireSpan {
  return {
    name: `handle ${spanId}`,
    spanKind: 'internal',
    traceId: 'trace-1',
    spanId,
    parentSpanId: null,
    startMs: 1_700_000_000_000,
    endMs: 1_700_000_000_001,
    startHighResolutionMs: 10,
    endHighResolutionMs: 11,
    status: 'ok',
    statusMessage: null,
    attributes: {},
    actorPath: 'actor-ts://test/user/worker',
    senderPath: null,
    messageType: 'Work',
    messagePayload: null,
    exceptions: [],
    ...overrides,
  };
}

describe('TracingPanelComponent', () => {
  let fixture: ComponentFixture<TracingPanelComponent>;

  async function mount(capacity = DEFAULT_CAPACITY): Promise<void> {
    TestBed.configureTestingModule({
      imports: [TracingPanelComponent],
      providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
    });
    TestBed.inject(TapClientService);
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture = TestBed.createComponent(TracingPanelComponent);
    fixture.detectChanges();
    // The panel says its ring size out loud on construction; without an answer
    // it keeps the default and the trimming assertions below have no handle.
    //
    // Awaited, and that is not tidiness: `setCapacity` resolves on a microtask,
    // so a synchronous `detectChanges` here reads the ring size the panel
    // started with rather than the one this test just handed it — which is a
    // trimming test that quietly asserts nothing.
    FakeTapSocket.latest.respondTo('tracing.buffer', { capacity, retained: 0 });
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /**
   * Deliver one batch, carrying the stream sequence the client checks.
   *
   * `sequenceNumber` is not decoration: `tapClient` stores it + 1 as what it
   * expects next, so a wrong one is read as a gap and the batch is dropped in
   * favour of a re-subscribe — which is the very mechanism some of these tests
   * are about, and would silently swallow the others.
   */
  function batch(spans: readonly WireSpan[], sequenceNumber = nextFrame++): void {
    FakeTapSocket.latest.receives({
      kind: 'event',
      stream: 'spans',
      sequenceNumber,
      payload: { kind: 'span-batch', atMs: 1_700_000_000_000, spans, dropped: 0 },
    });
    fixture.detectChanges();
  }

  /** The `N spans · M traces` reading, which is what the ring's size shows up as. */
  function spanCount(): number {
    const summary = (fixture.nativeElement as HTMLElement)
      .querySelector('.dt-toolbar__summary')?.textContent ?? '';
    return Number(/(\d[\d\s]*) spans/.exec(summary)?.[1]?.replace(/\s/g, '') ?? '-1');
  }

  /**
   * The message type of every listed trace.
   *
   * The one property of the ring that a test can actually SEE. `traceId` is
   * not rendered anywhere, so asserting on it passes whatever the panel does —
   * the first version of the ordering test below did exactly that, and went
   * green against the appending implementation it was written to catch.
   */
  function messageTypes(): string[] {
    return [...(fixture.nativeElement as HTMLElement)
      .querySelectorAll('.dt-tracetable__message')]
      .map((cell) => cell.textContent?.trim().split(/\s+/)[0] ?? '');
  }

  function traceCount(): number {
    const summary = (fixture.nativeElement as HTMLElement)
      .querySelector('.dt-toolbar__summary')?.textContent ?? '';
    return Number(/(\d[\d\s]*) traces/.exec(summary)?.[1]?.replace(/\s/g, '') ?? '-1');
  }

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
    nextFrame = 0;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('counts a span once when the server sends it again', async () => {
    await mount();
    batch([span('a'), span('b'), span('c')]);
    expect(spanCount()).toBe(3);

    // What `SpanTap.snapshot()` sends a re-subscriber: the whole ring, which
    // is everything the panel already holds.
    batch([span('a'), span('b'), span('c')]);

    expect(spanCount()).toBe(3);
    expect(traceCount()).toBe(1);
  });

  it('does not duplicate the ring when a sequence gap forces a re-subscribe', async () => {
    // The path this actually reaches in production. Driven end to end rather
    // than by hand-feeding a repeat batch, because the bug was never in the
    // batch — it was in what the recovery does with the snapshot it asked for.
    await mount();
    batch([span('a'), span('b')]);
    const subscribesBefore = FakeTapSocket.latest.sentOf('subscribe').length;

    // A frame out of order: the client drops it and asks for a fresh snapshot
    // rather than render state it can no longer trust.
    batch([span('x')], 99);
    expect(FakeTapSocket.latest.sentOf('subscribe').length).toBe(subscribesBefore + 1);
    expect(spanCount()).toBe(2);

    // The server answers the re-subscribe with its whole ring.
    batch([span('a'), span('b')], 0);

    expect(spanCount()).toBe(2);
  });

  it('does not duplicate the ring across a reconnect', async () => {
    // `onWelcome` re-subscribes every stream that still has listeners, so a
    // laptop waking from sleep takes the same path.
    await mount();
    batch([span('a'), span('b')]);
    expect(spanCount()).toBe(2);

    FakeTapSocket.latest.serverClosed();
    fixture.detectChanges();
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture.detectChanges();
    batch([span('a'), span('b')], 0);

    expect(spanCount()).toBe(2);
  });

  it('still takes a span it has not seen', async () => {
    // The half that a dedup can get wrong in the other direction: recognising
    // everything is as broken as recognising nothing.
    await mount();
    batch([span('a'), span('b')]);
    batch([span('b'), span('c')]);
    expect(spanCount()).toBe(3);
  });

  it('keeps a resent span in its original place rather than moving it', async () => {
    // Re-keying a `Map` entry leaves its insertion order alone, so a resent
    // span does not jump to the newest end of the ring and push a genuinely
    // newer one out. Appending gets this exactly backwards, which is why the
    // assertion names what survives AND what does not.
    await mount(2);
    batch([span('a', { traceId: 'ta', messageType: 'Ay' })]);
    batch([span('b', { traceId: 'tb', messageType: 'Bee' })]);
    batch([span('a', { traceId: 'ta', messageType: 'Ay' })]);
    batch([span('c', { traceId: 'tc', messageType: 'Cee' })]);

    expect(spanCount()).toBe(2);
    // 'a' was resent but is still the oldest, so the cap is what drops it.
    // Appending would have moved it to the end and dropped 'b' instead.
    expect(messageTypes().sort()).toEqual(['Bee', 'Cee']);
  });

  it('trims to the server ring, oldest first', async () => {
    await mount(3);
    batch([span('a'), span('b'), span('c'), span('d'), span('e')]);
    expect(spanCount()).toBe(3);
  });

  it('empties on Clear', async () => {
    await mount();
    batch([span('a'), span('b')]);
    const clear = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Clear');
    clear?.click();
    fixture.detectChanges();
    expect(spanCount()).toBe(0);
  });
});
