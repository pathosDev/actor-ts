import { Injectable, signal, computed } from '@angular/core';
import {
  type ChatMessage,
  type ClientMessage,
  DEFAULT_ROOMS,
  directMessageRoomFor,
  isDirectMessageRoom,
  isRoomName,
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
  /** RoomName → ReadonlyArray<username> currently typing.  Entries
   *  auto-clear 3 s after the last `user-typing` frame. */
  readonly typingByRoom = signal<Record<string, ReadonlyArray<string>>>({});
  /** RoomName → { [username]: read-up-to-ts }.  Synced from
   *  server's `read-receipts` broadcasts (DD-LWWMap-backed). */
  readonly receiptsByRoom = signal<Record<string, Readonly<Record<string, number>>>>({});

  readonly currentTyping = computed(() => {
    const room = this.currentRoom();
    return room ? (this.typingByRoom()[room] ?? []) : [];
  });
  readonly currentReceipts = computed(() => {
    const room = this.currentRoom();
    return room ? (this.receiptsByRoom()[room] ?? {}) : {};
  });

  readonly currentMessages = computed(() => {
    const room = this.currentRoom();
    return room ? (this.messagesByRoom()[room] ?? []) : [];
  });
  readonly currentUsers = computed(() => {
    const room = this.currentRoom();
    return room ? (this.usersByRoom()[room] ?? []) : [];
  });

  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-room, per-user clear timer for the typing indicator. */
  private readonly typingTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  /** Debounce: max one outbound `typing` frame per 2 s. */
  private lastTypingSentAt = 0;
  /** Per-room: last `read-up-to.ts` we sent — debounces redundant
   *  outbound frames (server enforces monotonic guard too). */
  private readonly lastReadSentByRoom = new Map<string, number>();

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
    this.connectImplementation((ws) =>
      ws.send(JSON.stringify({ type: 'login', username, password } satisfies ClientMessage)),
    );
  }

  /** Open a WS and authenticate with a stored session token. */
  private connectWithResume(token: string): void {
    this.connectImplementation((ws) =>
      ws.send(JSON.stringify({ type: 'resume', token } satisfies ClientMessage)),
    );
  }

  private connectImplementation(onOpen: (ws: WebSocket) => void): void {
    this.loginError.set('');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.ws = ws;
    ws.addEventListener('open', () => onOpen(ws));
    ws.addEventListener('message', (ev) => {
      const message = JSON.parse(ev.data as string) as ServerMessage;
      this.handleServer(message);
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

  /** Send a `typing` frame at most once per 2 s.  Called from the
   *  compose input's `input` event in the component. */
  notifyTyping(room: RoomName): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this.lastTypingSentAt < 2000) return;
    this.lastTypingSentAt = now;
    this.ws.send(JSON.stringify({ type: 'typing', room } satisfies ClientMessage));
  }

  selectRoom(room: RoomName): void {
    if (this.currentRoom() === room) return;
    // User-created rooms aren't auto-joined at login.  `join` is
    // idempotent server-side, so we send it unconditionally — the
    // server only registers presence + history-replay once per room
    // per session anyway.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'join', room } satisfies ClientMessage));
      this.ws.send(JSON.stringify({ type: 'switch-active-room', room } satisfies ClientMessage));
    }
    this.currentRoom.set(room);
    this.unreadByRoom.update((u) => ({ ...u, [room]: 0 }));
    // Switching INTO a room means the user is reading it — mark
    // the highest known ts as read for the sender's ✓✓.
    const msgs = this.messagesByRoom()[room] ?? [];
    const maxTs = msgs.reduce((a, message) => Math.max(a, message.ts), 0);
    if (maxTs > 0) this.markReadUpTo(room, maxTs);
  }

  /** Send `read-up-to` if it advances the last we sent for this room. */
  markReadUpTo(room: RoomName, ts: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const last = this.lastReadSentByRoom.get(room) ?? 0;
    if (ts <= last) return;
    this.lastReadSentByRoom.set(room, ts);
    this.ws.send(JSON.stringify({ type: 'read-up-to', room, ts } satisfies ClientMessage));
  }

  /**
   * Open a direct-message "room" with another online user.  Pure
   * client-side: adds `@<otherUser>` to `rooms` if missing, then
   * switches the active room to it.  The server only sees a `join` +
   * `switch-active-room` for the `@<other>` name, which it routes
   * through the DM shard region (#100).
   */
  openDirectMessage(otherUser: string): void {
    const me = this.username();
    if (!otherUser || otherUser === me) return;
    const room = directMessageRoomFor(otherUser);
    if (!this.rooms().includes(room)) {
      this.rooms.update((rs) => [...rs, room]);
      this.messagesByRoom.update((cur) => ({ ...cur, [room]: [] }));
      this.usersByRoom.update((cur) => ({ ...cur, [room]: [] }));
      this.unreadByRoom.update((cur) => ({ ...cur, [room]: 0 }));
    }
    this.selectRoom(room);
  }

  /**
   * Ask the cluster's `ChatRoomDirectoryActor` to create a room.
   * Returns `false` if the name fails the local shape guard (so the
   * caller can render an inline error without round-tripping); the
   * server validates again and silently rejects bad shapes.
   */
  createRoom(name: string): boolean {
    if (!isRoomName(name)) return false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'create-room', name } satisfies ClientMessage));
    }
    return true;
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

  private handleServer(message: ServerMessage): void {
    switch (message.type) {
      case 'logged-in':
        this.cancelReconnect();
        this.username.set(message.username);
        if (message.token && typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(TOKEN_KEY, message.token);
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
        this.loginError.set(message.reason || 'Login failed.');
        break;
      case 'rooms': {
        // Preserve open DMs — they live only on the client, never in
        // the directory.  Without this, every `RoomsChanged` would
        // wipe open conversations.
        const directMessages = this.rooms().filter(isDirectMessageRoom);
        const merged = [...message.rooms, ...directMessages];
        this.rooms.set(merged);
        this.messagesByRoom.update((cur) => {
          const next = { ...cur };
          for (const room of merged) next[room] ??= [];
          return next;
        });
        this.usersByRoom.update((cur) => {
          const next = { ...cur };
          for (const room of merged) next[room] ??= [];
          return next;
        });
        this.unreadByRoom.update((cur) => {
          const next = { ...cur };
          for (const room of merged) next[room] ??= 0;
          return next;
        });
        if (!this.currentRoom()) this.currentRoom.set(message.rooms[0] ?? DEFAULT_ROOMS[0]);
        break;
      }
      case 'room-added':
        // `rooms` carries the full set; this is the per-name notice
        // used for toast-style UX.  Idempotent — if the name is
        // already known, only the toast fires.
        if (!this.rooms().includes(message.name)) {
          this.rooms.update((rs) => [...rs, message.name]);
          this.messagesByRoom.update((cur) => ({ ...cur, [message.name]: [] }));
          this.usersByRoom.update((cur) => ({ ...cur, [message.name]: [] }));
          this.unreadByRoom.update((cur) => ({ ...cur, [message.name]: 0 }));
        }
        break;
      case 'room-removed': {
        this.rooms.update((rs) => rs.filter((room) => room !== message.name));
        const wasCurrent = this.currentRoom() === message.name;
        const dropKey = (cur: Record<string, unknown>): Record<string, unknown> => {
          const { [message.name]: _drop, ...rest } = cur;
          return rest;
        };
        this.messagesByRoom.update((cur) => dropKey(cur) as typeof cur);
        this.usersByRoom.update((cur) => dropKey(cur) as typeof cur);
        this.unreadByRoom.update((cur) => dropKey(cur) as typeof cur);
        if (wasCurrent) this.currentRoom.set(this.rooms()[0] ?? null);
        break;
      }
      case 'history':
        this.messagesByRoom.update((cur) => ({ ...cur, [message.room]: message.messages.slice() }));
        break;
      case 'message': {
        this.messagesByRoom.update((cur) => {
          const list = (cur[message.room] ?? []).slice();
          list.push({ from: message.from, text: message.text, ts: message.ts });
          return { ...cur, [message.room]: list };
        });
        if (message.room !== this.currentRoom()) {
          this.unreadByRoom.update((cur) => ({
            ...cur,
            [message.room]: (cur[message.room] ?? 0) + 1,
          }));
        } else {
          // Active view — mark read so the sender's ✓✓ updates.
          this.markReadUpTo(message.room, message.ts);
        }
        break;
      }
      case 'users': {
        const sorted = message.users.slice().sort();
        this.usersByRoom.update((cur) => ({ ...cur, [message.room]: sorted }));
        break;
      }
      case 'user-typing':
        this.onUserTyping(message.room, message.username);
        break;
      case 'read-receipts':
        this.receiptsByRoom.update((cur) => ({ ...cur, [message.room]: message.receipts }));
        break;
      case 'system':
        // Ignored in this minimal frontend; could be displayed inline.
        break;
    }
  }

  /** Add or refresh a typing indicator with a 3 s auto-clear. */
  private onUserTyping(room: RoomName, username: string): void {
    if (!username || username === this.username()) return;
    let perRoom = this.typingTimers.get(room);
    if (!perRoom) {
      perRoom = new Map();
      this.typingTimers.set(room, perRoom);
    }
    const existing = perRoom.get(username);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      perRoom!.delete(username);
      if (perRoom!.size === 0) this.typingTimers.delete(room);
      this.refreshTypingByRoom(room);
    }, 3000);
    perRoom.set(username, timer);
    this.refreshTypingByRoom(room);
  }

  private refreshTypingByRoom(room: RoomName): void {
    const perRoom = this.typingTimers.get(room);
    const list = perRoom ? [...perRoom.keys()] : [];
    this.typingByRoom.update((cur) => {
      const next = { ...cur };
      if (list.length === 0) delete next[room];
      else next[room] = list;
      return next;
    });
  }
}
