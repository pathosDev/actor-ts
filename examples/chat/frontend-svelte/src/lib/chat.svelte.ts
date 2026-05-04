import {
  type ChatMessage,
  type ClientMessage,
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

class ChatStore {
  phase = $state<'login' | 'chat'>('login');
  username = $state<string | null>(null);
  loginError = $state('');

  rooms = $state<RoomName[]>([]);
  currentRoom = $state<RoomName | null>(null);
  messagesByRoom = $state<Record<string, ChatMessage[]>>({});
  usersByRoom = $state<Record<string, string[]>>({});
  unreadByRoom = $state<Record<string, number>>({});

  #ws: WebSocket | null = null;

  constructor() {
    // Auto-resume on bootstrap.  Class-instances run on module
    // eval, which in Svelte's adapter-static client-only build
    // happens after the document is parsed — `localStorage` is
    // available at this point.  Guarded for SSR safety even though
    // we ship this app SSR-disabled.
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored) this.#connect((ws) =>
        ws.send(JSON.stringify({ type: 'resume', token: stored } satisfies ClientMessage)),
      );
    }
  }

  /** Open a WS and authenticate with credentials. */
  connect(username: string, password: string): void {
    this.#connect((ws) =>
      ws.send(JSON.stringify({ type: 'login', username, password } satisfies ClientMessage)),
    );
  }

  #connect(onOpen: (ws: WebSocket) => void): void {
    this.loginError = '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.#ws = ws;
    ws.addEventListener('open', () => onOpen(ws));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data as string) as ServerMessage;
      this.#handleServer(m);
    });
    ws.addEventListener('close', () => {
      if (this.#ws === ws) {
        this.#ws = null;
        if (this.phase === 'chat') this.#reset();
      }
    });
    ws.addEventListener('error', () => {
      if (this.phase === 'login') this.loginError = 'Connection failed.';
    });
  }

  send(room: RoomName, text: string): void {
    if (!text.trim() || !this.#ws) return;
    const cmd: ClientMessage = { type: 'send', room, text };
    this.#ws.send(JSON.stringify(cmd));
  }

  selectRoom(room: RoomName): void {
    if (this.currentRoom === room) return;
    this.currentRoom = room;
    this.unreadByRoom[room] = 0;
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      const cmd: ClientMessage = { type: 'switch-active-room', room };
      this.#ws.send(JSON.stringify(cmd));
    }
  }

  logout(): void {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      try { this.#ws.send(JSON.stringify({ type: 'logout' } satisfies ClientMessage)); } catch { /* ignore */ }
    }
    if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY);
    if (this.#ws) {
      try { this.#ws.close(1000, 'logout'); } catch { /* ignore */ }
      this.#ws = null;
    }
    this.#reset();
  }

  #reset(): void {
    this.phase = 'login';
    this.username = null;
    this.rooms = [];
    this.currentRoom = null;
    this.messagesByRoom = {};
    this.usersByRoom = {};
    this.unreadByRoom = {};
  }

  #handleServer(m: ServerMessage): void {
    switch (m.type) {
      case 'logged-in':
        this.username = m.username;
        if (m.token && typeof localStorage !== 'undefined') {
          localStorage.setItem(TOKEN_KEY, m.token);
        }
        this.phase = 'chat';
        break;
      case 'login-failed':
        this.loginError = m.reason || 'Login failed.';
        if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY);
        this.#ws?.close();
        this.#ws = null;
        break;
      case 'rooms': {
        this.rooms = m.rooms.slice();
        for (const r of m.rooms) {
          this.messagesByRoom[r] ??= [];
          this.usersByRoom[r] ??= [];
          this.unreadByRoom[r] ??= 0;
        }
        if (!this.currentRoom) this.currentRoom = m.rooms[0] ?? null;
        break;
      }
      case 'history':
        this.messagesByRoom[m.room] = m.messages.slice();
        break;
      case 'message': {
        const list = this.messagesByRoom[m.room] ?? [];
        list.push({ from: m.from, text: m.text, ts: m.ts });
        this.messagesByRoom[m.room] = list;
        if (m.room !== this.currentRoom) {
          this.unreadByRoom[m.room] = (this.unreadByRoom[m.room] ?? 0) + 1;
        }
        break;
      }
      case 'users':
        this.usersByRoom[m.room] = m.users.slice().sort();
        break;
      case 'system':
        break;
    }
  }
}

export const chat = new ChatStore();
