'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  type ChatMessage,
  type ClientMessage,
  type RoomName,
  type ServerMessage,
  WS_PATH,
} from './protocol';

/**
 * useChat — WebSocket + multi-room state, mirrors the React-Vite
 * variant.  Same reducer shape, same dispatch model — the
 * comparison point is the file-based routing + RSC layout in
 * `app/`, not the state plumbing.
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
  }
}

export function useChat(): {
  state: State;
  connect(username: string, password: string): void;
  logout(): void;
  send(room: RoomName, text: string): void;
  selectRoom(room: RoomName): void;
} {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const wsRef = useRef<WebSocket | null>(null);

  const handleServer = useCallback((m: ServerMessage) => {
    switch (m.type) {
      case 'logged-in':
        dispatch({ type: 'logged-in', username: m.username });
        break;
      case 'login-failed':
        dispatch({ type: 'login-error', reason: m.reason || 'Login failed.' });
        wsRef.current?.close();
        wsRef.current = null;
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
        break;
    }
  }, []);

  const connect = useCallback(
    (username: string, password: string) => {
      dispatch({ type: 'login-error', reason: '' });
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
      wsRef.current = ws;
      ws.addEventListener('open', () => {
        const cmd: ClientMessage = { type: 'login', username, password };
        ws.send(JSON.stringify(cmd));
      });
      ws.addEventListener('message', (ev) => {
        handleServer(JSON.parse(ev.data as string) as ServerMessage);
      });
      ws.addEventListener('close', () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
          dispatch({ type: 'reset' });
        }
      });
      ws.addEventListener('error', () => {
        dispatch({ type: 'login-error', reason: 'Connection failed.' });
      });
    },
    [handleServer],
  );

  const logout = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(1000, 'logout'); } catch { /* ignore */ }
      wsRef.current = null;
    }
    dispatch({ type: 'reset' });
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

  useEffect(() => {
    return () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, []);

  return { state, connect, logout, send, selectRoom };
}
