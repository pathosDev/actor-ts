import { Injectable, signal, computed } from '@angular/core';
import {
  type ChatMessage,
  type ClientMessage,
  DEFAULT_ROOMS,
  type RoomName,
  type ServerMessage,
  WS_PATH,
} from './protocol';

/**
 * Owns the WebSocket connection plus all chat-related signals.
 *
 * Signals make the Angular templates reactive without RxJS — they
 * update synchronously when the WS frame handler mutates them, and
 * Angular schedules a single change-detection pass.  The same
 * service handles login (the first frame after open) and
 * post-login multi-room state.
 */
const TOKEN_KEY = 'chat-token';
const MAX_RECONNECT_ATTEMPTS = 8;

@Injectable({ providedIn: 'root' })
export class ChatService {
  /**
   * 'login' shows the login form; 'chat' shows the chat view;
   * 'resuming' is a transient phase used right after page reload
   * when we have a stored token but haven't yet heard back from the
   * server.  Templates render nothing in 'resuming' so the login
   * form doesn't flash before the resume completes.
   */
  readonly phase = signal<'login' | 'resuming' | 'chat'>(
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem(TOKEN_KEY)
      ? 'resuming'
      : 'login',
  );
  readonly username = signal<string | null>(null);
  readonly loginError = signal<string>('');

  readonly rooms = signal<ReadonlyArray<RoomName>>([]);
  readonly currentRoom = signal<RoomName | null>(null);
  readonly messagesByRoom = signal<Record<string, ReadonlyArray<ChatMessage>>>({});
  readonly usersByRoom = signal<Record<string, ReadonlyArray<string>>>({});
  readonly unreadByRoom = signal<Record<string, number>>({});

  readonly currentMessages = computed(() => {
    const r = this.currentRoom();
    return r ? (this.messagesByRoom()[r] ?? []) : [];
  });
  readonly currentUsers = computed(() => {
    const r = this.currentRoom();
    return r ? (this.usersByRoom()[r] ?? []) : [];
  });

  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Auto-resume on bootstrap: if a token survived the page reload
    // (or the singleton-failover) jump straight to a `resume`
    // handshake.  Server replies with `logged-in` → handleServer
    // flips us into chat phase.  If the token is stale, server
    // replies `login-failed` → token cleared, login form shown.
    const stored = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(TOKEN_KEY)
      : null;
    if (stored) this.connectWithResume(stored);
  }

  /** Open a WS and authenticate with credentials. */
  connect(username: string, password: string): void {
    this.connectImpl((ws) =>
      ws.send(JSON.stringify({ type: 'login', username, password } satisfies ClientMessage)),
    );
  }

  /** Open a WS and authenticate with a stored session token. */
  private connectWithResume(token: string): void {
    this.connectImpl((ws) =>
      ws.send(JSON.stringify({ type: 'resume', token } satisfies ClientMessage)),
    );
  }

  private connectImpl(onOpen: (ws: WebSocket) => void): void {
    this.loginError.set('');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.ws = ws;
    ws.addEventListener('open', () => onOpen(ws));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data as string) as ServerMessage;
      this.handleServer(m);
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      // Don't drop to the login screen immediately — try to resume
      // with the stored token first.  Covers singleton-failover
      // (phase 'chat': the chat view stays mounted, frozen for a
      // few seconds, while the cluster re-binds :8080 on a
      // survivor) and reload-resume failure (phase 'resuming':
      // retry until the cluster is reachable again).
      if (!this.scheduleResumeReconnect() && this.phase() !== 'login') {
        this.reset();
      }
    });
    ws.addEventListener('error', () => {
      const hasStored = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(TOKEN_KEY);
      if (this.phase() === 'login' && !hasStored) {
        this.loginError.set('Connection failed.');
      }
    });
  }

  private scheduleResumeReconnect(): boolean {
    const token = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(TOKEN_KEY)
      : null;
    if (!token) return false;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = Math.min(500 * Math.pow(2, this.reconnectAttempts), 4000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWithResume(token);
    }, delay);
    return true;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  send(room: RoomName, text: string): void {
    if (!text.trim() || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'send', room, text } satisfies ClientMessage));
  }

  selectRoom(room: RoomName): void {
    if (this.currentRoom() === room) return;
    this.currentRoom.set(room);
    this.unreadByRoom.update((u) => ({ ...u, [room]: 0 }));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'switch-active-room', room } satisfies ClientMessage));
    }
  }

  logout(): void {
    this.cancelReconnect();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'logout' } satisfies ClientMessage)); } catch { /* ignore */ }
    }
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_KEY);
    if (this.ws) {
      try { this.ws.close(1000, 'logout'); } catch { /* ignore */ }
    }
    this.reset();
  }

  private reset(): void {
    this.cancelReconnect();
    this.phase.set('login');
    this.username.set(null);
    this.rooms.set([]);
    this.currentRoom.set(null);
    this.messagesByRoom.set({});
    this.usersByRoom.set({});
    this.unreadByRoom.set({});
    this.ws = null;
  }

  private handleServer(m: ServerMessage): void {
    switch (m.type) {
      case 'logged-in':
        this.cancelReconnect();
        this.username.set(m.username);
        if (m.token && typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(TOKEN_KEY, m.token);
        }
        this.loginError.set('');
        this.phase.set('chat');
        break;
      case 'login-failed':
        this.cancelReconnect();
        if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_KEY);
        this.ws?.close();
        this.ws = null;
        // Drop chat-state if we were already in chat (rare) or
        // in 'resuming' (token rejected after reload).  Either
        // way, fall back to the login screen.
        if (this.phase() !== 'login') this.reset();
        this.loginError.set(m.reason || 'Login failed.');
        break;
      case 'rooms': {
        const rooms = m.rooms.slice();
        this.rooms.set(rooms);
        this.messagesByRoom.update((cur) => {
          const next = { ...cur };
          for (const r of rooms) next[r] ??= [];
          return next;
        });
        this.usersByRoom.update((cur) => {
          const next = { ...cur };
          for (const r of rooms) next[r] ??= [];
          return next;
        });
        this.unreadByRoom.update((cur) => {
          const next = { ...cur };
          for (const r of rooms) next[r] ??= 0;
          return next;
        });
        if (!this.currentRoom()) this.currentRoom.set(rooms[0] ?? DEFAULT_ROOMS[0]);
        break;
      }
      case 'history':
        this.messagesByRoom.update((cur) => ({ ...cur, [m.room]: m.messages.slice() }));
        break;
      case 'message': {
        this.messagesByRoom.update((cur) => {
          const list = (cur[m.room] ?? []).slice();
          list.push({ from: m.from, text: m.text, ts: m.ts });
          return { ...cur, [m.room]: list };
        });
        if (m.room !== this.currentRoom()) {
          this.unreadByRoom.update((cur) => ({
            ...cur,
            [m.room]: (cur[m.room] ?? 0) + 1,
          }));
        }
        break;
      }
      case 'users': {
        const sorted = m.users.slice().sort();
        this.usersByRoom.update((cur) => ({ ...cur, [m.room]: sorted }));
        break;
      }
      case 'system':
        // Ignored in this minimal frontend; could be displayed inline.
        break;
    }
  }
}
