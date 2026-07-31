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

type State = {
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
};

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
  | { kind: 'login-error'; reason: string }
  | { kind: 'logged-in'; username: string }
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

function reducer(state: State, action: Action): State {
  // Internal state reduction — arms compute the next state and stay inline.
  return match(action)
    .with({ kind: 'login-error' }, (a) => ({ ...state, loginError: a.reason }))
    .with({ kind: 'logged-in' }, (a) => ({ ...state, phase: 'chat' as const, username: a.username, loginError: '' }))
    .with({ kind: 'reset' }, () => INITIAL)
    .with({ kind: 'rooms' }, (a) => {
      // Preserve open DMs across `rooms` broadcasts — they live only
      // in the client, not in the cluster-wide directory.
      const directMessages = state.rooms.filter(isDirectMessageRoom);
      const rooms = [...a.rooms, ...directMessages];
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
        currentRoom: state.currentRoom ?? a.rooms[0] ?? null,
      };
    })
    .with({ kind: 'room-added' }, (a) => {
      // `rooms` carries the full set; this action exists for the
      // per-name toast in the UI.  Idempotent — re-adding an existing
      // name is a no-op for the reducer.
      if (state.rooms.includes(a.name)) return state;
      return {
        ...state,
        rooms: [...state.rooms, a.name],
        messagesByRoom: { ...state.messagesByRoom, [a.name]: [] },
        usersByRoom:    { ...state.usersByRoom,    [a.name]: [] },
        unreadByRoom:   { ...state.unreadByRoom,   [a.name]: 0  },
      };
    })
    .with({ kind: 'room-removed' }, (a) => {
      const { [a.name]: _m, ...messagesByRoom } = state.messagesByRoom;
      const { [a.name]: _u, ...usersByRoom } = state.usersByRoom;
      const { [a.name]: _r, ...unreadByRoom } = state.unreadByRoom;
      return {
        ...state,
        rooms: state.rooms.filter((r) => r !== a.name),
        currentRoom: state.currentRoom === a.name
          ? (state.rooms.find((r) => r !== a.name) ?? null)
          : state.currentRoom,
        messagesByRoom,
        usersByRoom,
        unreadByRoom,
      };
    })
    .with({ kind: 'history' }, (a) => ({
      ...state,
      messagesByRoom: { ...state.messagesByRoom, [a.room]: a.messages.slice() },
    }))
    .with({ kind: 'message' }, (a) => {
      const list = (state.messagesByRoom[a.room] ?? []).slice();
      list.push({ from: a.from, text: a.text, ts: a.ts });
      const isCurrent = a.room === state.currentRoom;
      return {
        ...state,
        messagesByRoom: { ...state.messagesByRoom, [a.room]: list },
        unreadByRoom: isCurrent
          ? state.unreadByRoom
          : {
              ...state.unreadByRoom,
              [a.room]: (state.unreadByRoom[a.room] ?? 0) + 1,
            },
      };
    })
    .with({ kind: 'users' }, (a) => ({
      ...state,
      usersByRoom: {
        ...state.usersByRoom,
        [a.room]: a.users.slice().sort(),
      },
    }))
    .with({ kind: 'select-room' }, (a) => ({
      ...state,
      currentRoom: a.room,
      unreadByRoom: { ...state.unreadByRoom, [a.room]: 0 },
    }))
    .with({ kind: 'open-dm' }, (a) => {
      const room = directMessageRoomFor(a.otherUser);
      if (state.rooms.includes(room)) {
        // Already open — just switch.  Caller follows up with
        // `select-room` via the `openDirectMessage` callback.
        return state;
      }
      return {
        ...state,
        rooms: [...state.rooms, room],
        messagesByRoom: { ...state.messagesByRoom, [room]: [] },
        usersByRoom:    { ...state.usersByRoom,    [room]: [] },
        unreadByRoom:   { ...state.unreadByRoom,   [room]: 0  },
      };
    })
    .with({ kind: 'typing-add' }, (a) => {
      const list = state.typingByRoom[a.room] ?? [];
      if (list.includes(a.username)) return state;
      return {
        ...state,
        typingByRoom: { ...state.typingByRoom, [a.room]: [...list, a.username] },
      };
    })
    .with({ kind: 'typing-clear' }, (a) => {
      const list = state.typingByRoom[a.room] ?? [];
      const next = list.filter((u) => u !== a.username);
      const typingByRoom = { ...state.typingByRoom };
      if (next.length === 0) delete typingByRoom[a.room];
      else typingByRoom[a.room] = next;
      return { ...state, typingByRoom };
    })
    .with({ kind: 'receipts' }, (a) => ({
      ...state,
      receiptsByRoom: { ...state.receiptsByRoom, [a.room]: a.receipts },
    }))
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

  const onLoggedIn = useCallback((m: Extract<ServerMessage, { kind: 'logged-in' }>) => {
    cancelReconnect();
    if (m.token) sessionStorage.setItem(TOKEN_KEY, m.token);
    dispatch({ kind: 'logged-in', username: m.username });
  }, [cancelReconnect]);

  const onLoginFailed = useCallback((m: Extract<ServerMessage, { kind: 'login-failed' }>) => {
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
    dispatch({ kind: 'reset' });
    dispatch({ kind: 'login-error', reason: m.reason || 'Login failed.' });
  }, [cancelReconnect]);

  const onUserTyping = useCallback((m: Extract<ServerMessage, { kind: 'user-typing' }>) => {
    // Schedule a 3 s auto-clear, replacing any pending one for
    // the same (room, user) pair.  Refs hold the timer map so
    // the closure stays stable across renders.
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
  }, []);

  const handleServer = useCallback((m: ServerMessage) => {
    match(m)
      .with({ kind: 'logged-in' }, (f) => onLoggedIn(f))
      .with({ kind: 'login-failed' }, (f) => onLoginFailed(f))
      .with({ kind: 'rooms' }, (f) => dispatch({ kind: 'rooms', rooms: f.rooms }))
      .with({ kind: 'room-added' }, (f) => dispatch({ kind: 'room-added', name: f.name }))
      .with({ kind: 'room-removed' }, (f) => dispatch({ kind: 'room-removed', name: f.name }))
      .with({ kind: 'history' }, (f) => dispatch({ kind: 'history', room: f.room, messages: f.messages }))
      .with({ kind: 'message' }, (f) =>
        dispatch({ kind: 'message', room: f.room, from: f.from, text: f.text, ts: f.ts }))
      .with({ kind: 'users' }, (f) => dispatch({ kind: 'users', room: f.room, users: f.users }))
      .with({ kind: 'read-receipts' }, (f) => dispatch({ kind: 'receipts', room: f.room, receipts: f.receipts }))
      .with({ kind: 'user-typing' }, (f) => onUserTyping(f))
      // Ignored in this minimal frontend.
      .with({ kind: 'system' }, () => {})
      .exhaustive();
  }, [onLoggedIn, onLoginFailed, onUserTyping]);

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
        // Try to resume with the stored token before falling back
        // to the login screen.  Covers singleton-failover.
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

  // Auto-resume on first render: if a token survived the page
  // reload, jump straight to a `resume` handshake.  React's
  // `useEffect` with an empty dep array is the canonical place for
  // mount-once side effects.  Server replies steer the rest of the
  // flow via handleServer.
  useEffect(() => {
    const stored = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(TOKEN_KEY)
      : null;
    if (stored) connectImplementation({ kind: 'resume', token: stored });
    // We intentionally only run this once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((room: RoomName, text: string) => {
    if (!text.trim() || !wsRef.current) return;
    const command: ClientMessage = { kind: 'send', room, text };
    wsRef.current.send(JSON.stringify(command));
  }, []);

  /** Send a `typing` frame at most once per 2 s. */
  const notifyTyping = useCallback((room: RoomName): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastTypingSentAtRef.current < 2000) return;
    lastTypingSentAtRef.current = now;
    wsRef.current.send(JSON.stringify({ kind: 'typing', room } satisfies ClientMessage));
  }, []);

  /** Send `read-up-to` if it advances the last we sent for this room. */
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
      // User-created rooms aren't auto-joined at login.  `join` is
      // idempotent server-side, so sending it for every selection
      // is harmless.
      wsRef.current.send(JSON.stringify({ kind: 'join', room } satisfies ClientMessage));
      wsRef.current.send(JSON.stringify({ kind: 'switch-active-room', room } satisfies ClientMessage));
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
      wsRef.current.send(JSON.stringify({ kind: 'create-room', name } satisfies ClientMessage));
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
  const openDirectMessage = useCallback((otherUser: string): void => {
    dispatch({ kind: 'open-dm', otherUser });
    selectRoom(directMessageRoomFor(otherUser));
  }, [selectRoom]);

  return { state, connect, logout, send, notifyTyping, markReadUpTo, selectRoom, createRoom, openDirectMessage };
}
