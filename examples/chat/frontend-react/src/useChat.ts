import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  type ChatMessage,
  type ClientMessage,
  dmRoomFor,
  isDmRoom,
  isRoomName,
  type RoomName,
  type ServerMessage,
  WS_PATH,
} from './protocol';

/**
 * useChat — owns the WebSocket connection and maintains all chat
 * state via a single `useReducer`.  Designed so that:
 *   - The connection lifecycle is bound to the hook (open in
 *     `connect`, close in `logout`); React's `useEffect` cleanup
 *     handles unmounts.
 *   - Multi-room state lives in one reducer to keep updates atomic
 *     across rooms (`message` mutates messages + unread; `rooms`
 *     seeds three sub-maps).
 *   - The hook returns plain values + dispatch-style actions; UI
 *     components never see the raw socket.
 */

/**
 * 'login' shows the login form; 'chat' shows the chat view;
 * 'resuming' is a transient phase used right after page reload
 * when we have a stored token but haven't yet heard back from the
 * server.  Components render nothing in 'resuming' to avoid the
 * login-form-flash before resume completes.
 */
export type Phase = 'login' | 'resuming' | 'chat';

interface State {
  readonly phase: Phase;
  readonly username: string | null;
  readonly loginError: string;
  readonly rooms: ReadonlyArray<RoomName>;
  readonly currentRoom: RoomName | null;
  readonly messagesByRoom: Record<string, ReadonlyArray<ChatMessage>>;
  readonly usersByRoom: Record<string, ReadonlyArray<string>>;
  readonly unreadByRoom: Record<string, number>;
  /** Per-room list of usernames currently typing.  Entries auto-clear
   *  3 s after the last `user-typing` frame — managed via reducer
   *  actions `typing-add` and `typing-clear`. */
  readonly typingByRoom: Record<string, ReadonlyArray<string>>;
  /** RoomName → { [username]: read-up-to-ts }.  Synced from server's
   *  `read-receipts` broadcasts (DD-LWWMap-backed). */
  readonly receiptsByRoom: Record<string, Readonly<Record<string, number>>>;
}

const INITIAL: State = {
  phase: 'login',
  username: null,
  loginError: '',
  rooms: [],
  currentRoom: null,
  messagesByRoom: {},
  usersByRoom: {},
  unreadByRoom: {},
  typingByRoom: {},
  receiptsByRoom: {},
};

const TOKEN_KEY = 'chat-token';
const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Lazy initializer for `useReducer` — runs once at mount.  If a
 * token survived the reload we want to render nothing (phase
 * 'resuming') instead of flashing the login form before the
 * server replies to our `resume` frame.
 */
function init(): State {
  const stored = typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(TOKEN_KEY)
    : null;
  return stored ? { ...INITIAL, phase: 'resuming' } : INITIAL;
}

type Action =
  | { type: 'login-error'; reason: string }
  | { type: 'logged-in'; username: string }
  | { type: 'reset' }
  | { type: 'rooms'; rooms: ReadonlyArray<RoomName> }
  | { type: 'room-added'; name: RoomName }
  | { type: 'room-removed'; name: RoomName }
  | { type: 'history'; room: RoomName; messages: ReadonlyArray<ChatMessage> }
  | { type: 'message'; room: RoomName; from: string; text: string; ts: number }
  | { type: 'users'; room: RoomName; users: ReadonlyArray<string> }
  | { type: 'select-room'; room: RoomName }
  | { type: 'open-dm'; otherUser: string }
  | { type: 'typing-add'; room: RoomName; username: string }
  | { type: 'typing-clear'; room: RoomName; username: string }
  | { type: 'receipts'; room: RoomName; receipts: Readonly<Record<string, number>> };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'login-error':
      return { ...state, loginError: action.reason };
    case 'logged-in':
      return { ...state, phase: 'chat', username: action.username, loginError: '' };
    case 'reset':
      return INITIAL;
    case 'rooms': {
      // Preserve open DMs across `rooms` broadcasts — they live only
      // in the client, not in the cluster-wide directory.
      const dms = state.rooms.filter(isDmRoom);
      const rooms = [...action.rooms, ...dms];
      const messagesByRoom = { ...state.messagesByRoom };
      const usersByRoom = { ...state.usersByRoom };
      const unreadByRoom = { ...state.unreadByRoom };
      for (const r of rooms) {
        messagesByRoom[r] ??= [];
        usersByRoom[r] ??= [];
        unreadByRoom[r] ??= 0;
      }
      return {
        ...state,
        rooms,
        messagesByRoom,
        usersByRoom,
        unreadByRoom,
        currentRoom: state.currentRoom ?? action.rooms[0] ?? null,
      };
    }
    case 'room-added': {
      // `rooms` carries the full set; this action exists for the
      // per-name toast in the UI.  Idempotent — re-adding an existing
      // name is a no-op for the reducer.
      if (state.rooms.includes(action.name)) return state;
      return {
        ...state,
        rooms: [...state.rooms, action.name],
        messagesByRoom: { ...state.messagesByRoom, [action.name]: [] },
        usersByRoom:    { ...state.usersByRoom,    [action.name]: [] },
        unreadByRoom:   { ...state.unreadByRoom,   [action.name]: 0  },
      };
    }
    case 'room-removed': {
      const { [action.name]: _m, ...messagesByRoom } = state.messagesByRoom;
      const { [action.name]: _u, ...usersByRoom } = state.usersByRoom;
      const { [action.name]: _r, ...unreadByRoom } = state.unreadByRoom;
      return {
        ...state,
        rooms: state.rooms.filter((r) => r !== action.name),
        currentRoom: state.currentRoom === action.name
          ? (state.rooms.find((r) => r !== action.name) ?? null)
          : state.currentRoom,
        messagesByRoom,
        usersByRoom,
        unreadByRoom,
      };
    }
    case 'history':
      return {
        ...state,
        messagesByRoom: { ...state.messagesByRoom, [action.room]: action.messages.slice() },
      };
    case 'message': {
      const list = (state.messagesByRoom[action.room] ?? []).slice();
      list.push({ from: action.from, text: action.text, ts: action.ts });
      const isCurrent = action.room === state.currentRoom;
      return {
        ...state,
        messagesByRoom: { ...state.messagesByRoom, [action.room]: list },
        unreadByRoom: isCurrent
          ? state.unreadByRoom
          : {
              ...state.unreadByRoom,
              [action.room]: (state.unreadByRoom[action.room] ?? 0) + 1,
            },
      };
    }
    case 'users':
      return {
        ...state,
        usersByRoom: {
          ...state.usersByRoom,
          [action.room]: action.users.slice().sort(),
        },
      };
    case 'select-room':
      return {
        ...state,
        currentRoom: action.room,
        unreadByRoom: { ...state.unreadByRoom, [action.room]: 0 },
      };
    case 'open-dm': {
      const room = dmRoomFor(action.otherUser);
      if (state.rooms.includes(room)) {
        // Already open — just switch.  Caller follows up with
        // `select-room` via the `openDm` callback.
        return state;
      }
      return {
        ...state,
        rooms: [...state.rooms, room],
        messagesByRoom: { ...state.messagesByRoom, [room]: [] },
        usersByRoom:    { ...state.usersByRoom,    [room]: [] },
        unreadByRoom:   { ...state.unreadByRoom,   [room]: 0  },
      };
    }
    case 'typing-add': {
      const list = state.typingByRoom[action.room] ?? [];
      if (list.includes(action.username)) return state;
      return {
        ...state,
        typingByRoom: { ...state.typingByRoom, [action.room]: [...list, action.username] },
      };
    }
    case 'typing-clear': {
      const list = state.typingByRoom[action.room] ?? [];
      const next = list.filter((u) => u !== action.username);
      const typingByRoom = { ...state.typingByRoom };
      if (next.length === 0) delete typingByRoom[action.room];
      else typingByRoom[action.room] = next;
      return { ...state, typingByRoom };
    }
    case 'receipts':
      return {
        ...state,
        receiptsByRoom: { ...state.receiptsByRoom, [action.room]: action.receipts },
      };
  }
}

export function useChat(): {
  state: State;
  connect(username: string, password: string): void;
  logout(): void;
  send(room: RoomName, text: string): void;
  notifyTyping(room: RoomName): void;
  markReadUpTo(room: RoomName, ts: number): void;
  selectRoom(room: RoomName): void;
  createRoom(name: string): boolean;
  openDm(otherUser: string): void;
} {
  const [state, dispatch] = useReducer(reducer, undefined, init);
  const wsRef = useRef<WebSocket | null>(null);
  // Reconnect bookkeeping — refs (not state) so each render
  // uses the current value without re-binding callbacks.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Typing bookkeeping — per-room, per-user clear timers.  Refs so
  // the closures in `handleServer` always see the current map.
  const typingTimersRef = useRef<Map<string, Map<string, ReturnType<typeof setTimeout>>>>(new Map());
  const lastTypingSentAtRef = useRef(0);
  /** Per-room last `read-up-to.ts` sent — debounces redundant frames. */
  const lastReadSentByRoomRef = useRef<Map<string, number>>(new Map());

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
  }, []);

  const handleServer = useCallback((m: ServerMessage) => {
    switch (m.type) {
      case 'logged-in':
        cancelReconnect();
        if (m.token) sessionStorage.setItem(TOKEN_KEY, m.token);
        dispatch({ type: 'logged-in', username: m.username });
        break;
      case 'login-failed':
        // Stale or rejected token → wipe so the next reload doesn't
        // keep retrying with the same dead session.
        cancelReconnect();
        sessionStorage.removeItem(TOKEN_KEY);
        wsRef.current?.close();
        wsRef.current = null;
        // Reset before setting the error: 'reset' returns INITIAL
        // (which has empty loginError), so we'd lose the message
        // if we dispatched it first.  Order matters with React's
        // batched dispatches.
        dispatch({ type: 'reset' });
        dispatch({ type: 'login-error', reason: m.reason || 'Login failed.' });
        break;
      case 'rooms':
        dispatch({ type: 'rooms', rooms: m.rooms });
        break;
      case 'room-added':
        dispatch({ type: 'room-added', name: m.name });
        break;
      case 'room-removed':
        dispatch({ type: 'room-removed', name: m.name });
        break;
      case 'history':
        dispatch({ type: 'history', room: m.room, messages: m.messages });
        break;
      case 'message':
        dispatch({ type: 'message', room: m.room, from: m.from, text: m.text, ts: m.ts });
        break;
      case 'users':
        dispatch({ type: 'users', room: m.room, users: m.users });
        break;
      case 'read-receipts':
        dispatch({ type: 'receipts', room: m.room, receipts: m.receipts });
        break;
      case 'user-typing': {
        // Schedule a 3 s auto-clear, replacing any pending one for
        // the same (room, user) pair.  Refs hold the timer map so
        // the closure stays stable across renders.
        const { room, username } = m;
        if (!username) break;
        let perRoom = typingTimersRef.current.get(room);
        if (!perRoom) {
          perRoom = new Map();
          typingTimersRef.current.set(room, perRoom);
        }
        const existing = perRoom.get(username);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          perRoom!.delete(username);
          if (perRoom!.size === 0) typingTimersRef.current.delete(room);
          dispatch({ type: 'typing-clear', room, username });
        }, 3000);
        perRoom.set(username, timer);
        dispatch({ type: 'typing-add', room, username });
        break;
      }
      case 'system':
        // Ignored in this minimal frontend.
        break;
    }
  }, [cancelReconnect]);

  const connectImplementation = useCallback(
    (firstFrame: ClientMessage) => {
      dispatch({ type: 'login-error', reason: '' });
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
      wsRef.current = ws;
      ws.addEventListener('open', () => ws.send(JSON.stringify(firstFrame)));
      ws.addEventListener('message', (ev) => {
        handleServer(JSON.parse(ev.data as string) as ServerMessage);
      });
      ws.addEventListener('close', () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        // Try to resume with the stored token before falling back
        // to the login screen.  Covers singleton-failover.
        const token = sessionStorage.getItem(TOKEN_KEY);
        if (token && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(500 * Math.pow(2, reconnectAttemptsRef.current), 4000);
          reconnectAttemptsRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connectImplementation({ type: 'resume', token });
          }, delay);
        } else {
          dispatch({ type: 'reset' });
        }
      });
      ws.addEventListener('error', () => {
        if (!sessionStorage.getItem(TOKEN_KEY)) {
          dispatch({ type: 'login-error', reason: 'Connection failed.' });
        }
      });
    },
    [handleServer],
  );

  const connect = useCallback(
    (username: string, password: string) => {
      connectImplementation({ type: 'login', username, password });
    },
    [connectImplementation],
  );

  const logout = useCallback(() => {
    cancelReconnect();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: 'logout' } satisfies ClientMessage)); } catch { /* ignore */ }
    }
    sessionStorage.removeItem(TOKEN_KEY);
    if (wsRef.current) {
      try { wsRef.current.close(1000, 'logout'); } catch { /* ignore */ }
      wsRef.current = null;
    }
    dispatch({ type: 'reset' });
  }, [cancelReconnect]);

  // Auto-resume on first render: if a token survived the page
  // reload, jump straight to a `resume` handshake.  React's
  // `useEffect` with an empty dep array is the canonical place for
  // mount-once side effects.  Server replies steer the rest of the
  // flow via handleServer.
  useEffect(() => {
    const stored = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(TOKEN_KEY)
      : null;
    if (stored) connectImplementation({ type: 'resume', token: stored });
    // We intentionally only run this once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((room: RoomName, text: string) => {
    if (!text.trim() || !wsRef.current) return;
    const cmd: ClientMessage = { type: 'send', room, text };
    wsRef.current.send(JSON.stringify(cmd));
  }, []);

  /** Send a `typing` frame at most once per 2 s. */
  const notifyTyping = useCallback((room: RoomName): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastTypingSentAtRef.current < 2000) return;
    lastTypingSentAtRef.current = now;
    wsRef.current.send(JSON.stringify({ type: 'typing', room } satisfies ClientMessage));
  }, []);

  /** Send `read-up-to` if it advances the last we sent for this room. */
  const markReadUpTo = useCallback((room: RoomName, ts: number): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const last = lastReadSentByRoomRef.current.get(room) ?? 0;
    if (ts <= last) return;
    lastReadSentByRoomRef.current.set(room, ts);
    wsRef.current.send(JSON.stringify({ type: 'read-up-to', room, ts } satisfies ClientMessage));
  }, []);

  const selectRoom = useCallback((room: RoomName) => {
    dispatch({ type: 'select-room', room });
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // User-created rooms aren't auto-joined at login.  `join` is
      // idempotent server-side, so sending it for every selection
      // is harmless.
      wsRef.current.send(JSON.stringify({ type: 'join', room } satisfies ClientMessage));
      wsRef.current.send(JSON.stringify({ type: 'switch-active-room', room } satisfies ClientMessage));
    }
  }, []);

  /**
   * Ask the cluster's `ChatRoomDirectoryActor` to create a room.
   * Returns `false` if the local shape guard rejects the name; the
   * server validates again and silently drops invalid names too.
   */
  const createRoom = useCallback((name: string): boolean => {
    if (!isRoomName(name)) return false;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create-room', name } satisfies ClientMessage));
    }
    return true;
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, []);

  /**
   * Open a DM "room" with another online user.  Pure client-side
   * state — the server sees `join` + `switch-active-room` for the
   * resulting `@<otherUser>` name (via the `selectRoom` call below),
   * which the server routes through the DM shard region.
   */
  const openDm = useCallback((otherUser: string): void => {
    dispatch({ type: 'open-dm', otherUser });
    selectRoom(dmRoomFor(otherUser));
  }, [selectRoom]);

  return { state, connect, logout, send, notifyTyping, markReadUpTo, selectRoom, createRoom, openDm };
}
