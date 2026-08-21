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
import { SendPanelComponent } from './SendPanelComponent.js';

/**
 * The send-message panel (#553).
 *
 * This is the only panel that writes, so what it must get right is not
 * rendering but restraint: it offers only what the server will accept, and
 * it reports the server's refusal rather than inventing its own rules.
 */

let nextFrame = 0;

describe('SendPanelComponent', () => {
  let fixture: ComponentFixture<SendPanelComponent>;

  function mount(): void {
    TestBed.configureTestingModule({
      imports: [SendPanelComponent],
      providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
    });
    TestBed.inject(TapClientService);
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture = TestBed.createComponent(SendPanelComponent);
    fixture.detectChanges();
  }

  /** Deliver an actor-tree snapshot on the `actors` stream. */
  function tree(paths: readonly string[]): void {
    FakeTapSocket.latest.receives({
      kind: 'event',
      stream: 'actors',
      sequenceNumber: nextFrame++,
      payload: {
        kind: 'actor-tree-snapshot',
        atMs: 1_700_000_000_000,
        actors: paths.map((path) => ({
          path,
          name: path.slice(path.lastIndexOf('/') + 1),
          state: 'running',
          childCount: 0,
        })),
      },
    });
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function options(): string[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('option'))
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value !== '');
  }

  function sendButton(): HTMLButtonElement {
    return (fixture.nativeElement as HTMLElement)
      .querySelector('button') as HTMLButtonElement;
  }

  function choose(path: string): void {
    const select = (fixture.nativeElement as HTMLElement)
      .querySelector('select') as HTMLSelectElement;
    select.value = path;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
    nextFrame = 0;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('offers only actors the server will accept', () => {
    mount();
    tree([
      'actor-ts://test-system/user/orders',
      'actor-ts://test-system/system/devtools',
      'actor-ts://test-system/user/billing',
    ]);

    // Only the user tree can be sent to, so offering anything else would be
    // a choice the server is going to refuse.
    expect(options()).toEqual([
      'actor-ts://test-system/user/billing',
      'actor-ts://test-system/user/orders',
    ]);
  });

  it('will not send until an actor is chosen', () => {
    mount();
    tree(['actor-ts://test-system/user/orders']);
    expect(sendButton().disabled).toBe(true);

    choose('actor-ts://test-system/user/orders');
    expect(sendButton().disabled).toBe(false);
  });

  it('sends the chosen path with the body verbatim', () => {
    mount();
    tree(['actor-ts://test-system/user/orders']);
    choose('actor-ts://test-system/user/orders');

    const body = (fixture.nativeElement as HTMLElement)
      .querySelector('textarea') as HTMLTextAreaElement;
    body.value = '{"kind":"increment","by":2}';
    body.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    sendButton().click();

    const request = FakeTapSocket.latest.sentOf('request')
      .filter((frame) => frame['method'] === 'actors.send')
      .at(-1);
    // Verbatim: the server parses and validates, and a panel that
    // pre-processed the body would be a second place for those rules.
    expect(request!['parameters']).toEqual({
      path: 'actor-ts://test-system/user/orders',
      body: '{"kind":"increment","by":2}',
    });
  });

  it('logs what it sent, newest first', async () => {
    mount();
    tree(['actor-ts://test-system/user/orders']);
    choose('actor-ts://test-system/user/orders');

    expect(text()).toContain('Nothing sent yet');
    sendButton().click();
    FakeTapSocket.latest.respondTo('actors.send', {
      path: 'actor-ts://test-system/user/orders',
      messageType: 'increment',
      atMs: 1_700_000_000_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(text()).not.toContain('Nothing sent yet');
    expect(text()).toContain('increment');
  });

  it('reports the server’s refusal rather than its own rules', async () => {
    mount();
    tree(['actor-ts://test-system/user/orders']);
    choose('actor-ts://test-system/user/orders');
    sendButton().click();

    const frame = FakeTapSocket.latest.sentOf('request')
      .filter((candidate) => candidate['method'] === 'actors.send').at(-1)!;
    FakeTapSocket.latest.receives({
      kind: 'error',
      requestId: frame['requestId'],
      code: 'internal',
      message: '`body` must be a JSON object or array, not a bare value',
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    // The panel does not validate JSON itself: the server's message is the
    // authority, and duplicating those rules is how the two drift apart.
    expect(text()).toContain('The message was not sent');
    expect(text()).toContain('must be a JSON object or array');
  });

  it('clears a previous error when another actor is chosen', async () => {
    mount();
    tree(['actor-ts://test-system/user/orders', 'actor-ts://test-system/user/billing']);
    choose('actor-ts://test-system/user/orders');
    sendButton().click();

    const frame = FakeTapSocket.latest.sentOf('request')
      .filter((candidate) => candidate['method'] === 'actors.send').at(-1)!;
    FakeTapSocket.latest.receives({
      kind: 'error',
      requestId: frame['requestId'],
      code: 'internal',
      message: 'no such actor',
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(text()).toContain('The message was not sent');

    choose('actor-ts://test-system/user/billing');
    expect(text()).not.toContain('The message was not sent');
  });

  it('unsubscribes from the actor stream when destroyed', () => {
    mount();
    const subscribed = FakeTapSocket.latest.sentOf('subscribe').length;
    fixture.destroy();
    expect(FakeTapSocket.latest.sentOf('unsubscribe')).toHaveLength(subscribed);
  });
});
