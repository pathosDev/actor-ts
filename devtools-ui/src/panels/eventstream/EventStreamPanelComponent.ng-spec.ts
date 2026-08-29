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
import { TimeControlService } from '../../app/TimeControlService.js';
import { EventStreamPanelComponent } from './EventStreamPanelComponent.js';
import type { BusEvent } from '../../../../src/devtools/protocol/index.js';

/**
 * The bus panel (#553).
 *
 * A tail is mostly about what it does when it cannot keep up, so that is
 * what most of this covers: dropping is admitted rather than hidden, pausing
 * holds what arrives meanwhile, and the newest event stays at the top.
 */

let nextSequence = 0;
/**
 * Frames carry their own stream sequence, and the client checks it.
 *
 * Omitting it is not a shortcut: `tapClient` stores `sequenceNumber + 1`
 * as what it expects next, so an absent number makes that NaN and every
 * frame after the first reads as a gap and is dropped — a harness that
 * would have silently tested one batch and called it several.
 */
let nextFrame = 0;

function event(overrides: Partial<BusEvent> = {}): BusEvent {
  nextSequence++;
  return {
    sequenceNumber: nextSequence,
    atMs: 1_700_000_000_000,
    eventType: 'OrderPlaced',
    payload: { orderId: `order-${nextSequence}` },
    truncated: false,
    ...overrides,
  };
}

describe('EventStreamPanelComponent', () => {
  let fixture: ComponentFixture<EventStreamPanelComponent>;

  function mount(): void {
    TestBed.configureTestingModule({
      imports: [EventStreamPanelComponent],
      providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
    });
    TestBed.inject(TapClientService);
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture = TestBed.createComponent(EventStreamPanelComponent);
    fixture.detectChanges();
  }

  /** Deliver one batch on the `events` stream. */
  function batch(events: readonly BusEvent[], dropped = 0): void {
    deliver({ kind: 'bus-event-batch', atMs: 1_700_000_000_000, events, dropped });
  }

  /** Deliver any payload on the `events` stream, in sequence. */
  function deliver(payload: unknown): void {
    FakeTapSocket.latest.receives({
      kind: 'event',
      stream: 'events',
      sequenceNumber: nextFrame++,
      payload,
    });
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function rows(): HTMLElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement)
        .querySelectorAll('.dt-events__row:not(.dt-events__row--head)'),
    );
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim() === label);
    if (found === undefined) throw new Error(`no button labelled ${label}`);
    return found as HTMLButtonElement;
  }

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
    nextSequence = 0;
    nextFrame = 0;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('subscribes to the events stream on open', () => {
    mount();
    const subscribes = FakeTapSocket.latest.sentOf('subscribe')
      .filter((frame) => frame['stream'] === 'events');
    expect(subscribes).toHaveLength(1);
  });

  it('tails a batch newest first', () => {
    mount();
    batch([event({ eventType: 'First' }), event({ eventType: 'Second' })]);

    // The server sends a batch oldest-first; the panel shows newest at the
    // top, which is where a reader looks for what just happened.
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain('Second');
    expect(rows()[1]!.textContent).toContain('First');
  });

  it('shows a payload preview without expanding, and the whole thing when opened', () => {
    mount();
    batch([event({ payload: { orderId: 'abc', total: 9 } })]);

    expect(rows()[0]!.textContent).toContain('"orderId":"abc"');
    expect((fixture.nativeElement as HTMLElement)
      .querySelector('.dt-events__payload')).toBeNull();

    rows()[0]!.click();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement)
      .querySelector('.dt-events__payload')).not.toBeNull();
  });

  it('admits that the server dropped events rather than hiding it', () => {
    mount();
    batch([event()], 42);

    // A tail that silently skips is worse than one that admits it: the reader
    // draws conclusions from what is NOT there.
    expect(text()).toContain('The tail fell behind');
    expect(text()).toContain('42');
  });

  it('accumulates the dropped count across batches', () => {
    mount();
    batch([event()], 3);
    batch([event()], 4);
    expect(text()).toContain('7');
  });

  it('holds what arrives while paused and shows it on resume', () => {
    // Reversed deliberately in #1349. The old behaviour — discard, on the
    // grounds that resuming into a wall of everything is not what the button
    // promises — was right about a button that stopped this one tail. The
    // header control stops the whole view, and someone who froze the world to
    // study it has not asked to be blinded to what it did next. The panel no
    // longer owns a Pause button at all; the tap client does the holding.
    mount();
    const time = TestBed.inject(TimeControlService);

    batch([event({ eventType: 'BeforePause' })]);
    time.pause();
    fixture.detectChanges();

    batch([event({ eventType: 'WhilePaused' })]);
    fixture.detectChanges();

    expect(text()).not.toContain('WhilePaused');
    expect(rows()).toHaveLength(1);
    expect(text()).toContain('paused');

    time.resume();
    TestBed.tick();
    fixture.detectChanges();

    expect(text()).toContain('WhilePaused');
    expect(rows()).toHaveLength(2);
  });

  it('has no Pause button of its own any more', () => {
    // Two controls reading "Pause" with different reach was the confusing part,
    // so the local one is gone rather than layered under the global one.
    mount();
    expect(() => button('Pause')).toThrow(/no button labelled/);
    expect(() => button('Clear')).not.toThrow();
  });

  it('filters on event type and on payload', () => {
    mount();
    batch([
      event({ eventType: 'OrderPlaced', payload: { orderId: 'keep-me' } }),
      event({ eventType: 'ActorStarted', payload: { path: '/user/other' } }),
    ]);

    const input = (fixture.nativeElement as HTMLElement)
      .querySelector('input') as HTMLInputElement;
    input.value = 'OrderPlaced';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows()).toHaveLength(1);

    input.value = 'keep-me';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('OrderPlaced');
  });

  it('says the filter matched nothing, not that the bus is quiet', () => {
    mount();
    batch([event({ eventType: 'OrderPlaced' })]);

    const input = (fixture.nativeElement as HTMLElement)
      .querySelector('input') as HTMLInputElement;
    input.value = 'nothing-matches-this';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // Two different facts, and one message for both would be a lie in one case.
    expect(text()).toContain('Nothing in the tail matches that filter');
    expect(text()).not.toContain('Waiting for the first event');
  });

  it('clears the tail and the dropped count', () => {
    mount();
    batch([event(), event()], 5);
    button('Clear').click();
    fixture.detectChanges();

    expect(rows()).toHaveLength(0);
    expect(text()).not.toContain('The tail fell behind');
  });

  it('warns that a truncated event is not the whole thing', () => {
    mount();
    batch([event({ truncated: true })]);
    rows()[0]!.click();
    fixture.detectChanges();

    expect(text()).toContain('not the whole event');
  });

  it('distinguishes PubSub not started from started with no topics', async () => {
    mount();
    FakeTapSocket.latest.respondTo('pubsub.topics', { started: false, topics: [] });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(text()).toContain('Distributed PubSub is not started');

    TestBed.resetTestingModule();
    FakeTapSocket.reset();
    mount();
    FakeTapSocket.latest.respondTo('pubsub.topics', { started: true, topics: [] });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(text()).toContain('Started, with nothing subscribed');
  });

  it('lists the cluster topics when there are some', async () => {
    mount();
    FakeTapSocket.latest.respondTo('pubsub.topics', {
      started: true,
      topics: ['orders', 'shipping'],
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    const items = Array.from((fixture.nativeElement as HTMLElement)
      .querySelectorAll('.dt-topics__item'))
      .map((item) => item.textContent?.trim());
    expect(items).toEqual(['orders', 'shipping']);
  });

  it('ignores a payload kind it does not know, rather than breaking', () => {
    mount();
    deliver({ kind: 'something-a-newer-server-sends', whatever: true });

    // An older bundle must survive a newer server: the alternative is a panel
    // that throws on connect and shows nothing at all.
    expect(text()).toContain('Waiting for the first event');
  });
});
