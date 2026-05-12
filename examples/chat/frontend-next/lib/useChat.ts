'use client';

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
 * useChat — WebSocket + multi-room state, mirrors the React-Vite
 * variant.  Same reducer shape, same dispatch model — the
 * comparison point is the file-based routing + RSC layout in
 * `app/`, not the state plumbing.
 *
 * 'login' shows the login form; 'chat' shows the chat view;
 * 'resuming' is a transient phase used right after page reload
 * when we have a stored token but haven't yet heard back from the
 * server.  Page renders nothing in 'resuming' to avoid the
 * login-form-flash before resume completes.  We can't initialize
 * 'resuming' from `sessionStorage` synchronously (would cause a
 * hydration mismatch under static export), so we transition into
 * it from `useEffect` post-hydration via the `start-resuming`
 * action.
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
  /** Per-room list of usernames currently typing.  Auto-cleared
   *  3 s after the last `user-typing` frame via `typing-clear`. */
  readonly typingByRoom: Record<string, ReadonlyArray<string>>;
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
};

type Action =
  | { type: 'login-error'; reason: string }
  | { type: 'logged-in'; username: string }
  | { type: 'start-resuming' }
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
  | { type: 'typing-clear'; room: RoomName; username: string };

const TOKEN_KEY = 'chat-token';
const MAX_RECONNECT_ATTEMPTS = 8;

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'login-error':
      return { ...state, loginError: action.reason };
    case 'logged-in':
      return { ...state, phase: 'chat', username: action.username, loginError: '' };
    case 'start-resuming':
      return { ...state, phase: 'resuming' };
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
      // per-name toast in the UI.  Idempotent.
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
          : { ...state.unreadByRoom, [action.room]: (state.unreadByRoom[action.room] ?? 0) + 1 },
      };
    }
    case 'users':
      return {
        ...state,
        usersByRoom: { ...state.usersByRoom, [action.room]: action.users.slice().sort() },
      };
    case 'select-room':
      return {
        ...state,
        currentRoom: action.room,
        unreadByRoom: { ...state.unreadByRoom, [action.room]: 0 },
      };
    case 'open-dm': {
      const room = dmRoomFor(action.otherUser);
      if (state.rooms.includes(room)) return state;
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
  }
}

export function useChat(): {
  state: State;
  connect(username: string, password: string): void;
  logout(): void;
  send(room: RoomName, text: string): void;
  notifyTyping(room: RoomName): void;
  selectRoom(room: RoomName): void;
  createRoom(name: string): boolean;
  openDm(otherUser: string): void;
} {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const wsRef = useRef<WebSocket | null>(null);
  // Reconnect bookkeeping — refs so closures stay stable.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimersRef = useRef<Map<string, Map<string, ReturnType<typeof setTimeout>>>>(new Map());
  const lastTypingSentAtRef = useRef(0);

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
      case 'user-typing': {
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
        break;
    }
  }, [cancelReconnect]);

  const connectImpl = useCallback(
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
        // Try to resume with the stored token — covers singleton-
        // failover.  Backoff is exponential, capped at 4 s.
        const token = sessionStorage.getItem(TOKEN_KEY);
        if (token && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(500 * Math.pow(2, reconnectAttemptsRef.current), 4000);
          reconnectAttemptsRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connectImpl({ type: 'resume', token });
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
      connectImpl({ type: 'login', username, password });
    },
    [connectImpl],
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

  const send = useCallback((room: RoomName, text: string) => {
    if (!text.trim() || !wsRef.current) return;
    const cmd: ClientMessage = { type: 'send', room, text };
    wsRef.current.send(JSON.stringify(cmd));
  }, []);

  const notifyTyping = useCallback((room: RoomName): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastTypingSentAtRef.current < 2000) return;
    lastTypingSentAtRef.current = now;
    wsRef.current.send(JSON.stringify({ type: 'typing', room } satisfies ClientMessage));
  }, []);

  const selectRoom = useCallback((room: RoomName) => {
    dispatch({ type: 'select-room', room });
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // User-created rooms aren't auto-joined.  `join` is idempotent
      // server-side, so sending it for every selection is safe.
      wsRef.current.send(JSON.stringify({ type: 'join', room } satisfies ClientMessage));
      wsRef.current.send(JSON.stringify({ type: 'switch-active-room', room } satisfies ClientMessage));
    }
  }, []);

  /**
   * Ask the cluster's `ChatRoomDirectoryActor` to create a room.
   * Returns `false` if the local shape guard rejects the name;
   * the server validates again and silently drops invalid names.
   */
  const createRoom = useCallback((name: string): boolean => {
    if (!isRoomName(name)) return false;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create-room', name } satisfies ClientMessage));
    }
    return true;
  }, []);

  // Auto-resume on first render: if a token survived the page
  // reload (or the singleton-failover) jump straight to a `resume`
  // handshake.  We dispatch `start-resuming` first so page.tsx
  // renders nothing instead of the login form while the WS
  // handshake is in flight — under static export the initial
  // render is `phase: 'login'` (sessionStorage isn't available
  // server-side), so we can't seed 'resuming' synchronously
  // without a hydration mismatch.
  useEffect(() => {
    const stored = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(TOKEN_KEY)
      : null;
    if (stored) {
      dispatch({ type: 'start-resuming' });
      connectImpl({ type: 'resume', token: stored });
    }
    return () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
    // We only want this to fire on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Open a DM "room" with another online user.  Pure client-side
   * state; subsequent `select-room` carries the protocol-level
   * `join` + `switch-active-room` for the resulting `@<other>` name.
   */
  const openDm = useCallback((otherUser: string): void => {
    dispatch({ type: 'open-dm', otherUser });
    selectRoom(dmRoomFor(otherUser));
  }, [selectRoom]);

  return { state, connect, logout, send, notifyTyping, selectRoom, createRoom, openDm };
}
