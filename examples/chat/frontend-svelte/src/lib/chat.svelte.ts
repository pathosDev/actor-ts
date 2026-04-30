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

  connect(username: string, password: string): void {
    this.loginError = '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.#ws = ws;
    ws.addEventListener('open', () => {
      const cmd: ClientMessage = { type: 'login', username, password };
      ws.send(JSON.stringify(cmd));
    });
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
        this.phase = 'chat';
        break;
      case 'login-failed':
        this.loginError = m.reason || 'Login failed.';
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
