'use client';

import { match } from 'ts-pattern';
import { useCallback, useEffect, useReducer, useRef } from 'react';
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
  /** RoomName → { [username]: read-up-to-ts }. */
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

type Action =
  | { kind: 'login-error'; reason: string }
  | { kind: 'logged-in'; username: string }
  | { kind: 'start-resuming' }
  | { kind: 'reset' }
  | { kind: 'rooms'; rooms: ReadonlyArray<RoomName> }
  | { kind: 'room-added'; name: RoomName }
  | { kind: 'room-removed'; name: RoomName }
  | { kind: 'history'; room: RoomName; messages: ReadonlyArray<ChatMessage> }
  | { kind: 'message'; room: RoomName; from: string; text: string; ts: number }
  | { kind: 'users'; room: RoomName; users: ReadonlyArray<string> }
  | { kind: 'select-room'; room: RoomName }
  | { kind: 'open-dm'; otherUser: string }
  | { kind: 'typing-add'; room: RoomName; username: string }
  | { kind: 'typing-clear'; room: RoomName; username: string }
  | { kind: 'receipts'; room: RoomName; receipts: Readonly<Record<string, number>> };

const TOKEN_KEY = 'chat-token';
const MAX_RECONNECT_ATTEMPTS = 8;

function reducer(state: State, action: Action): State {
  return match(action)
    .with({ kind: 'login-error' }, (action) => ({ ...state, loginError: action.reason }))
    .with({ kind: 'logged-in' }, (action) => ({ ...state, phase: 'chat' as const, username: action.username, loginError: '' }))
    .with({ kind: 'start-resuming' }, (action) => ({ ...state, phase: 'resuming' as const }))
    .with({ kind: 'reset' }, (action) => INITIAL)
    .with({ kind: 'rooms' }, (action) => {
      // Preserve open DMs across `rooms` broadcasts — they live only
      // in the client, not in the cluster-wide directory.
      const directMessages = state.rooms.filter(isDirectMessageRoom);
      const rooms = [...action.rooms, ...directMessages];
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
    })
    .with({ kind: 'room-added' }, (action) => {
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
    })
    .with({ kind: 'room-removed' }, (action) => {
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
    })
    .with({ kind: 'history' }, (action) => {
      return {
        ...state,
        messagesByRoom: { ...state.messagesByRoom, [action.room]: action.messages.slice() },
      };
    })
    .with({ kind: 'message' }, (action) => {
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
    })
    .with({ kind: 'users' }, (action) => {
      return {
        ...state,
        usersByRoom: { ...state.usersByRoom, [action.room]: action.users.slice().sort() },
      };
    })
    .with({ kind: 'select-room' }, (action) => {
      return {
        ...state,
        currentRoom: action.room,
        unreadByRoom: { ...state.unreadByRoom, [action.room]: 0 },
      };
    })
    .with({ kind: 'open-dm' }, (action) => {
      const room = directMessageRoomFor(action.otherUser);
      if (state.rooms.includes(room)) return state;
      return {
        ...state,
        rooms: [...state.rooms, room],
        messagesByRoom: { ...state.messagesByRoom, [room]: [] },
        usersByRoom:    { ...state.usersByRoom,    [room]: [] },
        unreadByRoom:   { ...state.unreadByRoom,   [room]: 0  },
      };
    })
    .with({ kind: 'typing-add' }, (action) => {
      const list = state.typingByRoom[action.room] ?? [];
      if (list.includes(action.username)) return state;
      return {
        ...state,
        typingByRoom: { ...state.typingByRoom, [action.room]: [...list, action.username] },
      };
    })
    .with({ kind: 'typing-clear' }, (action) => {
      const list = state.typingByRoom[action.room] ?? [];
      const next = list.filter((u) => u !== action.username);
      const typingByRoom = { ...state.typingByRoom };
      if (next.length === 0) delete typingByRoom[action.room];
      else typingByRoom[action.room] = next;
      return { ...state, typingByRoom };
    })
    .with({ kind: 'receipts' }, (action) => {
      return {
        ...state,
        receiptsByRoom: { ...state.receiptsByRoom, [action.room]: action.receipts },
      };
    })
    .exhaustive();
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
  openDirectMessage(otherUser: string): void;
} {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const wsRef = useRef<WebSocket | null>(null);
  // Reconnect bookkeeping — refs so closures stay stable.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimersRef = useRef<Map<string, Map<string, ReturnType<typeof setTimeout>>>>(new Map());
  const lastTypingSentAtRef = useRef(0);
  const lastReadSentByRoomRef = useRef<Map<string, number>>(new Map());

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
  }, []);

  const handleServer = useCallback((m: ServerMessage) => {
    match(m)
      .with({ kind: 'logged-in' }, (m) => {
        cancelReconnect();
        if (m.token) sessionStorage.setItem(TOKEN_KEY, m.token);
        dispatch({ kind: 'logged-in', username: m.username });
      })
      .with({ kind: 'login-failed' }, (m) => {
        cancelReconnect();
        sessionStorage.removeItem(TOKEN_KEY);
        wsRef.current?.close();
        wsRef.current = null;
        // Reset before setting the error: 'reset' returns INITIAL
        // (which has empty loginError), so we'd lose the message
        // if we dispatched it first.  Order matters with React's
        // batched dispatches.
        dispatch({ kind: 'reset' });
        dispatch({ kind: 'login-error', reason: m.reason || 'Login failed.' });
      })
      .with({ kind: 'rooms' }, (m) => dispatch({ kind: 'rooms', rooms: m.rooms }))
      .with({ kind: 'room-added' }, (m) => dispatch({ kind: 'room-added', name: m.name }))
      .with({ kind: 'room-removed' }, (m) => dispatch({ kind: 'room-removed', name: m.name }))
      .with({ kind: 'history' }, (m) => dispatch({ kind: 'history', room: m.room, messages: m.messages }))
      .with({ kind: 'message' }, (m) => dispatch({ kind: 'message', room: m.room, from: m.from, text: m.text, ts: m.ts }))
      .with({ kind: 'users' }, (m) => dispatch({ kind: 'users', room: m.room, users: m.users }))
      .with({ kind: 'read-receipts' }, (m) => dispatch({ kind: 'receipts', room: m.room, receipts: m.receipts }))
      .with({ kind: 'user-typing' }, (m) => {
        const { room, username } = m;
        if (!username) return;
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
          dispatch({ kind: 'typing-clear', room, username });
        }, 3000);
        perRoom.set(username, timer);
        dispatch({ kind: 'typing-add', room, username });
      })
      // Ignored in this minimal frontend.
      .with({ kind: 'system' }, () => {})
      .exhaustive();
  }, [cancelReconnect]);

  const connectImplementation = useCallback(
    (firstFrame: ClientMessage) => {
      dispatch({ kind: 'login-error', reason: '' });
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
            connectImplementation({ kind: 'resume', token });
          }, delay);
        } else {
          dispatch({ kind: 'reset' });
        }
      });
      ws.addEventListener('error', () => {
        if (!sessionStorage.getItem(TOKEN_KEY)) {
          dispatch({ kind: 'login-error', reason: 'Connection failed.' });
        }
      });
    },
    [handleServer],
  );

  const connect = useCallback(
    (username: string, password: string) => {
      connectImplementation({ kind: 'login', username, password });
    },
    [connectImplementation],
  );

  const logout = useCallback(() => {
    cancelReconnect();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ kind: 'logout' } satisfies ClientMessage)); } catch { /* ignore */ }
    }
    sessionStorage.removeItem(TOKEN_KEY);
    if (wsRef.current) {
      try { wsRef.current.close(1000, 'logout'); } catch { /* ignore */ }
      wsRef.current = null;
    }
    dispatch({ kind: 'reset' });
  }, [cancelReconnect]);

  const send = useCallback((room: RoomName, text: string) => {
    if (!text.trim() || !wsRef.current) return;
    const command: ClientMessage = { kind: 'send', room, text };
    wsRef.current.send(JSON.stringify(command));
  }, []);

  const notifyTyping = useCallback((room: RoomName): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastTypingSentAtRef.current < 2000) return;
    lastTypingSentAtRef.current = now;
    wsRef.current.send(JSON.stringify({ kind: 'typing', room } satisfies ClientMessage));
  }, []);

  const markReadUpTo = useCallback((room: RoomName, ts: number): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const last = lastReadSentByRoomRef.current.get(room) ?? 0;
    if (ts <= last) return;
    lastReadSentByRoomRef.current.set(room, ts);
    wsRef.current.send(JSON.stringify({ kind: 'read-up-to', room, ts } satisfies ClientMessage));
  }, []);

  const selectRoom = useCallback((room: RoomName) => {
    dispatch({ kind: 'select-room', room });
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // User-created rooms aren't auto-joined.  `join` is idempotent
      // server-side, so sending it for every selection is safe.
      wsRef.current.send(JSON.stringify({ kind: 'join', room } satisfies ClientMessage));
      wsRef.current.send(JSON.stringify({ kind: 'switch-active-room', room } satisfies ClientMessage));
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
      wsRef.current.send(JSON.stringify({ kind: 'create-room', name } satisfies ClientMessage));
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
      dispatch({ kind: 'start-resuming' });
      connectImplementation({ kind: 'resume', token: stored });
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
  const openDirectMessage = useCallback((otherUser: string): void => {
    dispatch({ kind: 'open-dm', otherUser });
    selectRoom(directMessageRoomFor(otherUser));
  }, [selectRoom]);

  return { state, connect, logout, send, notifyTyping, markReadUpTo, selectRoom, createRoom, openDirectMessage };
}
