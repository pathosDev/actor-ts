import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  type ChatMessage,
  type ClientMessage,
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

export type Phase = 'login' | 'chat';

interface State {
  readonly phase: Phase;
  readonly username: string | null;
  readonly loginError: string;
  readonly rooms: ReadonlyArray<RoomName>;
  readonly currentRoom: RoomName | null;
  readonly messagesByRoom: Record<string, ReadonlyArray<ChatMessage>>;
  readonly usersByRoom: Record<string, ReadonlyArray<string>>;
  readonly unreadByRoom: Record<string, number>;
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
};

type Action =
  | { type: 'login-error'; reason: string }
  | { type: 'logged-in'; username: string }
  | { type: 'reset' }
  | { type: 'rooms'; rooms: ReadonlyArray<RoomName> }
  | { type: 'history'; room: RoomName; messages: ReadonlyArray<ChatMessage> }
  | { type: 'message'; room: RoomName; from: string; text: string; ts: number }
  | { type: 'users'; room: RoomName; users: ReadonlyArray<string> }
  | { type: 'select-room'; room: RoomName };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'login-error':
      return { ...state, loginError: action.reason };
    case 'logged-in':
      return { ...state, phase: 'chat', username: action.username, loginError: '' };
    case 'reset':
      return INITIAL;
    case 'rooms': {
      const rooms = action.rooms.slice();
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
        currentRoom: state.currentRoom ?? rooms[0] ?? null,
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
  }
}

const TOKEN_KEY = 'chat-token';
const MAX_RECONNECT_ATTEMPTS = 8;

export function useChat(): {
  state: State;
  connect(username: string, password: string): void;
  logout(): void;
  send(room: RoomName, text: string): void;
  selectRoom(room: RoomName): void;
} {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const wsRef = useRef<WebSocket | null>(null);
  // Reconnect bookkeeping — refs (not state) so each render
  // uses the current value without re-binding callbacks.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        if (m.token) localStorage.setItem(TOKEN_KEY, m.token);
        dispatch({ type: 'logged-in', username: m.username });
        break;
      case 'login-failed':
        // Stale or rejected token → wipe so the next reload doesn't
        // keep retrying with the same dead session.
        cancelReconnect();
        localStorage.removeItem(TOKEN_KEY);
        dispatch({ type: 'login-error', reason: m.reason || 'Login failed.' });
        wsRef.current?.close();
        wsRef.current = null;
        dispatch({ type: 'reset' });
        break;
      case 'rooms':
        dispatch({ type: 'rooms', rooms: m.rooms });
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
      case 'system':
        // Ignored in this minimal frontend.
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
        // Try to resume with the stored token before falling back
        // to the login screen.  Covers singleton-failover.
        const token = localStorage.getItem(TOKEN_KEY);
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
        if (!localStorage.getItem(TOKEN_KEY)) {
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
    localStorage.removeItem(TOKEN_KEY);
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
    const stored = typeof localStorage !== 'undefined'
      ? localStorage.getItem(TOKEN_KEY)
      : null;
    if (stored) connectImpl({ type: 'resume', token: stored });
    // We intentionally only run this once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((room: RoomName, text: string) => {
    if (!text.trim() || !wsRef.current) return;
    const cmd: ClientMessage = { type: 'send', room, text };
    wsRef.current.send(JSON.stringify(cmd));
  }, []);

  const selectRoom = useCallback((room: RoomName) => {
    dispatch({ type: 'select-room', room });
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const cmd: ClientMessage = { type: 'switch-active-room', room };
      wsRef.current.send(JSON.stringify(cmd));
    }
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, []);

  return { state, connect, logout, send, selectRoom };
}
