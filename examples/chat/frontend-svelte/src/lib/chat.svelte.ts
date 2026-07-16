import {
  type ChatMessage,
  type ClientMessage,
  directMessageRoomFor,
  isDirectMessageRoom,
  isRoomName,
  type RoomName,
  type ServerMessage,
  WS_PATH,
} from './protocol';

/**
 * Svelte-5-Runes-based chat store.
 *
 * Returned object exposes deeply-reactive `$state` fields plus
 * imperative actions; components import the shared `chat` instance
 * and read / mutate it directly.  No stores, no contexts — runes
 * make this idiomatic.
 *
 * The `.svelte.ts` extension is what tells the Svelte compiler to
 * lift `$state(...)` calls into reactive primitives; using `.ts`
 * here would render the runes inert.
 */

const TOKEN_KEY = 'chat-token';
const MAX_RECONNECT_ATTEMPTS = 8;

class ChatStore {
  // 'resuming' is a transient phase used right after page reload
  // when we have a stored token but haven't yet heard back from the
  // server.  Components render nothing in that phase to avoid the
  // login-form-flash before resume completes.
  phase = $state<'login' | 'resuming' | 'chat'>(
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem(TOKEN_KEY)
      ? 'resuming'
      : 'login',
  );
  username = $state<string | null>(null);
  loginError = $state('');

  rooms = $state<RoomName[]>([]);
  currentRoom = $state<RoomName | null>(null);
  messagesByRoom = $state<Record<string, ChatMessage[]>>({});
  usersByRoom = $state<Record<string, string[]>>({});
  unreadByRoom = $state<Record<string, number>>({});
  /** Per-room list of usernames currently typing.  Entries
   *  auto-clear 3 s after the last `user-typing` frame. */
  typingByRoom = $state<Record<string, string[]>>({});
  /** RoomName → { [username]: read-up-to-ts }. */
  receiptsByRoom = $state<Record<string, Readonly<Record<string, number>>>>({});

  #ws: WebSocket | null = null;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-room, per-user clear timers for the typing indicator. */
  readonly #typingTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  /** Debounce: max one outbound `typing` frame per 2 s. */
  #lastTypingSentAt = 0;
  /** Per-room last `read-up-to.ts` sent — debounces redundant frames. */
  readonly #lastReadSentByRoom = new Map<string, number>();

  constructor() {
    // Auto-resume on bootstrap.  Class-instances run on module
    // eval, which in Svelte's adapter-static client-only build
    // happens after the document is parsed — `sessionStorage` is
    // available at this point.  Guarded for SSR safety even though
    // we ship this app SSR-disabled.
    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem(TOKEN_KEY);
      if (stored) this.#connect((ws) =>
        ws.send(JSON.stringify({ kind: 'resume', token: stored } satisfies ClientMessage)),
      );
    }
  }

  /** Open a WS and authenticate with credentials. */
  connect(username: string, password: string): void {
    this.#connect((ws) =>
      ws.send(JSON.stringify({ kind: 'login', username, password } satisfies ClientMessage)),
    );
  }

  #connect(onOpen: (ws: WebSocket) => void): void {
    this.loginError = '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.#ws = ws;
    ws.addEventListener('open', () => onOpen(ws));
    ws.addEventListener('message', (ev) => {
      const message = JSON.parse(ev.data as string) as ServerMessage;
      this.#handleServer(message);
    });
    ws.addEventListener('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      // Try to resume with the stored token before falling back
      // to the login screen.  Covers singleton-failover (phase
      // 'chat') and reload-resume failure (phase 'resuming') alike.
      if (!this.#scheduleResumeReconnect() && this.phase !== 'login') {
        this.#reset();
      }
    });
    ws.addEventListener('error', () => {
      if (this.phase === 'login' && typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(TOKEN_KEY)) {
        this.loginError = 'Connection failed.';
      }
    });
  }

  #scheduleResumeReconnect(): boolean {
    const token = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(TOKEN_KEY)
      : null;
    if (!token) return false;
    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false;
    const delay = Math.min(500 * Math.pow(2, this.#reconnectAttempts), 4000);
    this.#reconnectAttempts++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect((ws) =>
        ws.send(JSON.stringify({ kind: 'resume', token } satisfies ClientMessage)),
      );
    }, delay);
    return true;
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#reconnectAttempts = 0;
  }

  send(room: RoomName, text: string): void {
    if (!text.trim() || !this.#ws) return;
    const cmd: ClientMessage = { kind: 'send', room, text };
    this.#ws.send(JSON.stringify(cmd));
  }

  /** Send a `typing` frame at most once per 2 s. */
  notifyTyping(room: RoomName): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this.#lastTypingSentAt < 2000) return;
    this.#lastTypingSentAt = now;
    this.#ws.send(JSON.stringify({ kind: 'typing', room } satisfies ClientMessage));
  }

  /** Send `read-up-to` if it advances the last we sent for this room. */
  markReadUpTo(room: RoomName, ts: number): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    const last = this.#lastReadSentByRoom.get(room) ?? 0;
    if (ts <= last) return;
    this.#lastReadSentByRoom.set(room, ts);
    this.#ws.send(JSON.stringify({ kind: 'read-up-to', room, ts } satisfies ClientMessage));
  }

  selectRoom(room: RoomName): void {
    if (this.currentRoom === room) return;
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      // User-created rooms aren't auto-joined at login.  `join` is
      // idempotent server-side, so sending it for every selection
      // is harmless.
      this.#ws.send(JSON.stringify({ kind: 'join', room } satisfies ClientMessage));
      this.#ws.send(JSON.stringify({ kind: 'switch-active-room', room } satisfies ClientMessage));
    }
    this.currentRoom = room;
    this.unreadByRoom[room] = 0;
    // Switching INTO a room means the user is reading whatever's
    // already there — mark the highest known ts as read.
    const msgs = this.messagesByRoom[room] ?? [];
    const maxTs = msgs.reduce((a, message) => Math.max(a, message.ts ?? 0), 0);
    if (maxTs > 0) this.markReadUpTo(room, maxTs);
  }

  /**
   * Open a DM "room" with another online user.  Pure client-side
   * state; subsequent `selectRoom` carries the `join` +
   * `switch-active-room` protocol frames for the `@<otherUser>` name.
   */
  openDirectMessage(otherUser: string): void {
    if (!otherUser || otherUser === this.username) return;
    const room = directMessageRoomFor(otherUser);
    if (!this.rooms.includes(room)) {
      this.rooms = [...this.rooms, room];
      this.messagesByRoom[room] ??= [];
      this.usersByRoom[room] ??= [];
      this.unreadByRoom[room] ??= 0;
    }
    this.selectRoom(room);
  }

  /**
   * Ask the cluster's `ChatRoomDirectoryActor` to create a room.
   * Returns `false` if the local shape guard rejects the name;
   * server validates again and silently drops invalid names.
   */
  createRoom(name: string): boolean {
    if (!isRoomName(name)) return false;
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ kind: 'create-room', name } satisfies ClientMessage));
    }
    return true;
  }

  logout(): void {
    this.#cancelReconnect();
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      try { this.#ws.send(JSON.stringify({ kind: 'logout' } satisfies ClientMessage)); } catch { /* ignore */ }
    }
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_KEY);
    if (this.#ws) {
      try { this.#ws.close(1000, 'logout'); } catch { /* ignore */ }
      this.#ws = null;
    }
    this.#reset();
  }

  #reset(): void {
    this.#cancelReconnect();
    this.phase = 'login';
    this.username = null;
    this.rooms = [];
    this.currentRoom = null;
    this.messagesByRoom = {};
    this.usersByRoom = {};
    this.unreadByRoom = {};
  }

  #handleServer(message: ServerMessage): void {
    switch (message.kind) {
      case 'logged-in':
        this.#cancelReconnect();
        this.username = message.username;
        if (message.token && typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(TOKEN_KEY, message.token);
        }
        this.loginError = '';
        this.phase = 'chat';
        break;
      case 'login-failed':
        this.#cancelReconnect();
        if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_KEY);
        this.#ws?.close();
        this.#ws = null;
        // Drop chat-state if we were already in chat (rare) or
        // in 'resuming' (token rejected after reload).  Either
        // way, fall back to the login screen.
        if (this.phase !== 'login') this.#reset();
        this.loginError = message.reason || 'Login failed.';
        break;
      case 'rooms': {
        // Preserve open DMs across `rooms` broadcasts — they live
        // only in the client, not in the cluster-wide directory.
        const directMessages = this.rooms.filter(isDirectMessageRoom);
        this.rooms = [...message.rooms, ...directMessages];
        for (const r of this.rooms) {
          this.messagesByRoom[r] ??= [];
          this.usersByRoom[r] ??= [];
          this.unreadByRoom[r] ??= 0;
        }
        if (!this.currentRoom) this.currentRoom = message.rooms[0] ?? null;
        break;
      }
      case 'room-added':
        // `rooms` carries the full set; this is the per-name notice
        // for toast UX.  Idempotent.
        if (!this.rooms.includes(message.name)) {
          this.rooms = [...this.rooms, message.name];
          this.messagesByRoom[message.name] ??= [];
          this.usersByRoom[message.name] ??= [];
          this.unreadByRoom[message.name] ??= 0;
        }
        break;
      case 'room-removed': {
        this.rooms = this.rooms.filter((r) => r !== message.name);
        const wasCurrent = this.currentRoom === message.name;
        delete this.messagesByRoom[message.name];
        delete this.usersByRoom[message.name];
        delete this.unreadByRoom[message.name];
        if (wasCurrent) this.currentRoom = this.rooms[0] ?? null;
        break;
      }
      case 'history':
        this.messagesByRoom[message.room] = message.messages.slice();
        break;
      case 'message': {
        const list = this.messagesByRoom[message.room] ?? [];
        list.push({ from: message.from, text: message.text, ts: message.ts });
        this.messagesByRoom[message.room] = list;
        if (message.room !== this.currentRoom) {
          this.unreadByRoom[message.room] = (this.unreadByRoom[message.room] ?? 0) + 1;
        } else {
          // Active view — mark read so the sender's ✓✓ updates.
          this.markReadUpTo(message.room, message.ts);
        }
        break;
      }
      case 'users':
        this.usersByRoom[message.room] = message.users.slice().sort();
        break;
      case 'user-typing':
        this.#onUserTyping(message.room, message.username);
        break;
      case 'read-receipts':
        this.receiptsByRoom = { ...this.receiptsByRoom, [message.room]: message.receipts };
        break;
      case 'system':
        break;
    }
  }

  #onUserTyping(room: RoomName, username: string): void {
    if (!username || username === this.username) return;
    let perRoom = this.#typingTimers.get(room);
    if (!perRoom) {
      perRoom = new Map();
      this.#typingTimers.set(room, perRoom);
    }
    const existing = perRoom.get(username);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      perRoom!.delete(username);
      if (perRoom!.size === 0) this.#typingTimers.delete(room);
      this.#refreshTypingByRoom(room);
    }, 3000);
    perRoom.set(username, timer);
    this.#refreshTypingByRoom(room);
  }

  #refreshTypingByRoom(room: RoomName): void {
    const perRoom = this.#typingTimers.get(room);
    const list = perRoom ? [...perRoom.keys()] : [];
    if (list.length === 0) {
      const { [room]: _drop, ...rest } = this.typingByRoom;
      this.typingByRoom = rest;
    } else {
      this.typingByRoom = { ...this.typingByRoom, [room]: list };
    }
  }
}

export const chat = new ChatStore();
