import { TAP_SOCKET_FACTORY, TAP_URL } from '../TapClientService.js';
import type { DevToolsPanelDescriptor, WelcomeFrame } from '../../../../src/devtools/protocol/index.js';

/**
 * A `WebSocket` the test drives, standing in for the real one.
 *
 * Test-only, and unreachable from `main.ts` — `tsconfig.app.json` compiles from
 * the bootstrap outwards, so nothing here reaches the bundle.  It lives under
 * `src/` rather than beside the specs because three spec files need it and a
 * copy in each is three things to keep in step.
 *
 * The seam it plugs into is `TAP_SOCKET_FACTORY` (#485).  Before that existed,
 * `connectTap` reached `new WebSocket(...)` directly and none of the reconnect,
 * gap-recovery or refcount behaviour could be reached from a test at all.
 */

type Listener = (event: unknown) => void;

export class FakeTapSocket {
  static instances: FakeTapSocket[] = [];

  static reset(): void {
    FakeTapSocket.instances = [];
  }

  static get latest(): FakeTapSocket {
    const socket = FakeTapSocket.instances[FakeTapSocket.instances.length - 1];
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  }

  /** Mirrors `WebSocket.readyState`; the client checks it before sending. */
  readyState = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeTapSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.serverClosed();
  }

  /* ----------------------------- test controls ---------------------------- */

  /** Frames this socket sent, of one kind. */
  sentOf(kind: string): Array<Record<string, unknown>> {
    return (this.sent as Array<Record<string, unknown>>).filter((frame) => frame['kind'] === kind);
  }

  opened(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  receives(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  serverClosed(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

/** Providers that point the tap at a socket the test owns. */
export const FAKE_TAP_PROVIDERS = [
  { provide: TAP_URL, useValue: 'ws://test/api/ws' },
  {
    provide: TAP_SOCKET_FACTORY,
    useValue: (url: string) => new FakeTapSocket(url) as unknown as WebSocket,
  },
];

/** A handshake with the given panel roster; every field the UI reads is set. */
export function fakeWelcome(panels: readonly DevToolsPanelDescriptor[]): WelcomeFrame {
  return {
    kind: 'welcome',
    protocolVersion: 1,
    serverVersion: '0.16.0',
    systemName: 'test-system',
    startedAtMs: 0,
    streams: ['stats', 'actors', 'cluster', 'spans', 'profiler'],
    panels,
  } as WelcomeFrame;
}

/** Every panel active, which is the ordinary case. */
export const ALL_PANELS_ACTIVE: readonly DevToolsPanelDescriptor[] = [
  'dashboard', 'actors', 'cluster', 'tracing', 'explain', 'time-travel', 'profiler',
].map((id) => ({ id, status: 'active' })) as DevToolsPanelDescriptor[];
