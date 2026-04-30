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
@Injectable({ providedIn: 'root' })
export class ChatService {
  /** 'login' before login succeeds, 'chat' afterwards. */
  readonly phase = signal<'login' | 'chat'>('login');
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

  connect(username: string, password: string): void {
    this.loginError.set('');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.ws = ws;
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ type: 'login', username, password } satisfies ClientMessage)),
    );
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data as string) as ServerMessage;
      this.handleServer(m);
    });
    ws.addEventListener('close', () => {
      if (this.phase() === 'chat') this.reset();
    });
    ws.addEventListener('error', () => {
      if (this.phase() === 'login') this.loginError.set('Connection failed.');
    });
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
    if (this.ws) {
      try { this.ws.close(1000, 'logout'); } catch { /* ignore */ }
    }
    this.reset();
  }

  private reset(): void {
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
        this.username.set(m.username);
        this.phase.set('chat');
        break;
      case 'login-failed':
        this.loginError.set(m.reason || 'Login failed.');
        this.ws?.close();
        this.ws = null;
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
