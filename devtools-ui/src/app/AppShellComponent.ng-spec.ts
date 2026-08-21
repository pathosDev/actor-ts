import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router, withHashLocation } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShellComponent } from './AppShellComponent.js';
import { TAP_SOCKET_FACTORY, TAP_URL, TapClientService } from './TapClientService.js';
import { installDomGaps } from './testing/domGaps.js';
import type { DevToolsPanelDescriptor, WelcomeFrame } from '../../../src/devtools/protocol/index.js';

/**
 * The shell, against a socket the test drives.
 *
 * What is worth asserting here is the part that is decided by the SERVER rather
 * than by the bundle: the UI ships every panel, and the `welcome` handshake
 * says which of them can do anything against the system being looked at.  Get
 * that wrong and the reader either loses a panel that works or opens one that
 * cannot answer.
 */

type Listener = (event: unknown) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  static get latest(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  }

  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) { FakeSocket.instances.push(this); }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(): void {}
  close(): void {}

  opened(): void { this.readyState = 1; this.emit('open', {}); }
  receives(frame: unknown): void { this.emit('message', { data: JSON.stringify(frame) }); }
  serverClosed(): void { this.readyState = 3; this.emit('close', {}); }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function welcome(panels: readonly DevToolsPanelDescriptor[]): WelcomeFrame {
  return {
    kind: 'welcome',
    protocolVersion: 1,
    serverVersion: '0.16.0',
    systemName: 'test-system',
    startedAtMs: 0,
    streams: ['stats'],
    panels,
  } as WelcomeFrame;
}

/** Every panel active, which is the ordinary case. */
const ALL_ACTIVE: readonly DevToolsPanelDescriptor[] = [
  'dashboard', 'actors', 'cluster', 'tracing', 'explain', 'time-travel', 'profiler',
].map((id) => ({ id, status: 'active' })) as DevToolsPanelDescriptor[];

describe('AppShellComponent', () => {
  let fixture: ComponentFixture<AppShellComponent>;

  const mount = async (): Promise<ComponentFixture<AppShellComponent>> => {
    TestBed.configureTestingModule({
      imports: [AppShellComponent],
      providers: [
        provideZonelessChangeDetection(),
        // Route shells only: the assertions are about the nav and the notice,
        // and loading seven real panels would drag ECharts into a DOM test.
        provideRouter(
          ['dashboard', 'actors', 'cluster', 'tracing', 'explain', 'time-travel', 'profiler']
            .map((path) => ({ path, children: [] })),
          withHashLocation(),
        ),
        { provide: TAP_URL, useValue: 'ws://test/api/ws' },
        {
          provide: TAP_SOCKET_FACTORY,
          useValue: (url: string) => new FakeSocket(url) as unknown as WebSocket,
        },
      ],
    });
    TestBed.inject(TapClientService);
    fixture = TestBed.createComponent(AppShellComponent);
    fixture.detectChanges();
    // The shell reads the active panel from the router, and nothing has
    // navigated yet — the real application redirects '' to the dashboard.
    // Awaited, because a navigation resolves on a microtask that no amount of
    // advancing fake timers will flush.
    await TestBed.inject(Router).navigateByUrl('/dashboard');
    fixture.detectChanges();
    return fixture;
  };

  const navigationItems = (): HTMLElement[] =>
    [...fixture.nativeElement.querySelectorAll('.dt-nav__item')] as HTMLElement[];

  beforeEach(() => {
    installDomGaps();
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  describe('navigation is built from the handshake', () => {
    it('offers every panel the server says is active', async () => {
      await mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome(ALL_ACTIVE));
      fixture.detectChanges();

      const items = navigationItems();
      expect(items).toHaveLength(7);
      expect(items.every((item) => item.tagName === 'A')).toBe(true);
    });

    it('renders an unavailable panel as a non-link that still names itself', () => {
      // `title` alone would BECOME the accessible name, so a screen reader would
      // announce the reason and never the panel. Both, in that order.
      mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome([
        { id: 'dashboard', status: 'active' },
        { id: 'cluster', status: 'unavailable', reason: 'not clustered' },
      ] as DevToolsPanelDescriptor[]));
      fixture.detectChanges();

      const cluster = navigationItems().find((item) => item.textContent?.includes('Cluster'))!;
      expect(cluster.tagName).toBe('SPAN');
      expect(cluster.getAttribute('aria-disabled')).toBe('true');
      expect(cluster.getAttribute('title')).toBe('not clustered');
      expect(cluster.getAttribute('aria-label')).toBe('Cluster — not clustered');
    });

    it('says why, rather than showing an empty panel, when the active route is unusable', async () => {
      await mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome([
        { id: 'dashboard', status: 'disabled', reason: 'stats tap is off' },
      ] as DevToolsPanelDescriptor[]));
      fixture.detectChanges();

      const notice = fixture.nativeElement.querySelector('.dt-notice');
      expect(notice?.textContent).toContain('Overview is not available');
      expect(notice?.textContent).toContain('stats tap is off');
    });

    it('treats a panel the server never mentions as unavailable', async () => {
      await mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome([{ id: 'dashboard', status: 'active' }] as DevToolsPanelDescriptor[]));
      fixture.detectChanges();

      const profiler = navigationItems().find((item) => item.textContent?.includes('Profiler'))!;
      expect(profiler.tagName).toBe('SPAN');
    });

    it('shows every panel as unavailable before the handshake lands', () => {
      // "not connected" is honest; offering links that cannot work is not.
      mount();
      expect(navigationItems().every((item) => item.tagName === 'SPAN')).toBe(true);
    });
  });

  describe('the header', () => {
    it('names the system and the protocol once connected', async () => {
      await mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome(ALL_ACTIVE));
      fixture.detectChanges();

      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector('.dt-header__system')?.textContent?.trim()).toBe('test-system');
      expect(element.querySelector('.dt-status')?.textContent).toContain('live');
      expect(element.querySelector('.dt-status')?.getAttribute('title')).toContain('actor-ts 0.16.0');
    });

    it('reads as connecting before anything answers', async () => {
      await mount();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector('.dt-header__system')?.textContent?.trim()).toBe('…');
      expect(element.querySelector('.dt-status')?.textContent).toContain('connecting');
    });
  });

  describe('the offline dialog waits out an ordinary reconnect', () => {
    it('stays shut while the connection is healthy', async () => {
      await mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome(ALL_ACTIVE));
      vi.advanceTimersByTime(10_000);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.dt-app--offline')).toBeNull();
    });

    it('does not announce an outage inside the two-second grace period', () => {
      // A reconnect goes connecting → closed → connecting while it retries, and
      // a dialog for every blink would be worse than the silence it replaces.
      mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome(ALL_ACTIVE));
      fixture.detectChanges();

      FakeSocket.latest.serverClosed();
      fixture.detectChanges();
      vi.advanceTimersByTime(1_500);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.dt-app--offline')).toBeNull();
    });

    it('announces it once the grace period has passed', async () => {
      await mount();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome(ALL_ACTIVE));
      fixture.detectChanges();

      FakeSocket.latest.serverClosed();
      fixture.detectChanges();
      vi.advanceTimersByTime(2_500);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.dt-app--offline')).not.toBeNull();
      const dialog = fixture.nativeElement.querySelector('.dt-dialog') as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      expect(dialog.textContent).toContain('No node reachable');
    });
  });
});
