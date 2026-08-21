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
import { DeadLettersPanelComponent } from './DeadLettersPanelComponent.js';
import type { DeadLetterView } from '../../../../src/devtools/protocol/index.js';

/**
 * The dead-letter panel (#553).
 *
 * What is worth testing here is what the panel does with an answer, not that
 * it renders: the payload is the reason someone opens it, and a payload the
 * server had to degrade or truncate must say so rather than showing a
 * plausible-looking `null` as if it were the message.
 */

function view(overrides: Partial<DeadLetterView> = {}): DeadLetterView {
  return {
    id: 'dl-1',
    timestampMs: 1_700_000_000_000,
    recipientPath: 'actor-ts://test-system/user/orders/checkout',
    senderPath: 'actor-ts://test-system/user/cart',
    messageType: 'PlaceOrderCommand',
    payload: { kind: 'place-order', total: 42 },
    truncated: false,
    degradedReason: null,
    replayCount: 0,
    ...overrides,
  };
}

function answer(entries: readonly DeadLetterView[], total = entries.length, capacity = 500) {
  return { entries, total, capacity };
}

describe('DeadLettersPanelComponent', () => {
  let fixture: ComponentFixture<DeadLettersPanelComponent>;

  function mount(): void {
    TestBed.configureTestingModule({
      imports: [DeadLettersPanelComponent],
      providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
    });
    TestBed.inject(TapClientService);
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture = TestBed.createComponent(DeadLettersPanelComponent);
    fixture.detectChanges();
  }

  /** Let the request promise settle, then re-render. */
  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function rows(): HTMLElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement)
        .querySelectorAll('.dt-deadletters__row:not(.dt-deadletters__row--head)'),
    );
  }

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('asks for the queue as soon as it mounts', () => {
    mount();
    const requests = FakeTapSocket.latest.sentOf('request')
      .filter((frame) => frame['method'] === 'deadletters.list');
    expect(requests).toHaveLength(1);
  });

  it('shows a captured letter with its recipient, sender and type', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([view()]));
    await settle();

    expect(rows()).toHaveLength(1);
    expect(text()).toContain('PlaceOrderCommand');
    expect(text()).toContain('checkout');
    expect(text()).toContain('cart');
  });

  it('says so plainly when nothing has died', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([]));
    await settle();

    // "Every message the system sent has been delivered" rather than an empty
    // box: a tool that shows nothing is indistinguishable from one that broke.
    expect(text()).toContain('Every message the system sent has been delivered');
  });

  it('reveals the payload only when a row is opened', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([view()]));
    await settle();

    expect(text()).not.toContain('place-order');
    rows()[0]!.click();
    fixture.detectChanges();
    expect(text()).toContain('place-order');
    expect(text()).toContain('42');
  });

  it('says the payload was not kept instead of showing a bare null', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([
      view({ payload: null, degradedReason: 'not serialisable: circular structure' }),
    ]));
    await settle();
    rows()[0]!.click();
    fixture.detectChanges();

    expect(text()).toContain('The payload was not kept');
    expect(text()).toContain('circular structure');
    // The distinction that matters: a degraded entry must not render a `null`
    // payload block, which reads as "the message WAS null".
    expect((fixture.nativeElement as HTMLElement)
      .querySelector('.dt-deadletters__payload')).toBeNull();
  });

  it('warns that a truncated payload is not the whole message', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([
      view({ truncated: true, payload: { kind: 'huge' } }),
    ]));
    await settle();
    rows()[0]!.click();
    fixture.detectChanges();

    expect(text()).toContain('not the whole message');
    // Still shows what it has — a truncated payload is worth more than none.
    expect((fixture.nativeElement as HTMLElement)
      .querySelector('.dt-deadletters__payload')).not.toBeNull();
  });

  it('flags a letter that has already been replayed', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([view({ replayCount: 3 })]));
    await settle();

    // A non-zero count changes what the reader is looking at: a poison message
    // being retried, not a fresh failure.
    expect(rows()[0]!.textContent).toContain('3');
    expect(rows()[0]!.querySelector('.dt-state--warn')).not.toBeNull();
  });

  it('reports how full the queue is, and when a page hides some of it', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([view()], 640, 1000));
    await settle();

    expect(text()).toContain('640 of 1 000 kept');
    expect(text()).toContain('1 shown');
  });

  it('sends the typed path as a filter, debounced', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([view()]));
    await settle();

    const input = (fixture.nativeElement as HTMLElement)
      .querySelector('input') as HTMLInputElement;
    input.value = '/user/orders';
    input.dispatchEvent(new Event('input'));

    // Nothing yet — a request per keystroke is what the debounce prevents.
    const before = FakeTapSocket.latest.sentOf('request').length;
    vi.advanceTimersByTime(199);
    expect(FakeTapSocket.latest.sentOf('request')).toHaveLength(before);

    vi.advanceTimersByTime(1);
    const filtered = FakeTapSocket.latest.sentOf('request').at(-1);
    expect(filtered!['parameters']).toEqual({ recipient: '/user/orders' });
  });

  it('polls once a second while it is open, and stops when destroyed', async () => {
    mount();
    FakeTapSocket.latest.respondTo('deadletters.list', answer([]));
    await settle();

    const after = () => FakeTapSocket.latest.sentOf('request').length;
    const baseline = after();
    vi.advanceTimersByTime(1000);
    expect(after()).toBe(baseline + 1);

    fixture.destroy();
    vi.advanceTimersByTime(5000);
    // A panel nobody is looking at must stop asking — the poll outliving the
    // component is invisible locally and a standing cost on the server.
    expect(after()).toBe(baseline + 1);
  });

  it('surfaces a failed request instead of showing a stale table', async () => {
    mount();
    const frame = FakeTapSocket.latest.sentOf('request').at(-1)!;
    FakeTapSocket.latest.receives({
      kind: 'error',
      requestId: frame['requestId'],
      code: 'internal',
      message: 'queue is closed',
    });
    await settle();

    expect(text()).toContain('Could not read the dead-letter queue');
    expect(text()).toContain('queue is closed');
  });
});
