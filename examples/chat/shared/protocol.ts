/**
 * Wire-format definitions shared between the chat backend and every
 * frontend (plain HTML, Angular, React, Next.js, SvelteKit, Lit).
 *
 * The protocol is a single bidirectional stream of JSON-encoded
 * frames over `/ws`.  No REST endpoints — login, history, message
 * send, and presence updates all flow through this channel.
 *
 *   Client → Server (`ClientMessage`):
 *     { type: 'login',  username, password }   // MUST be the first frame
 *     { type: 'send',   room, text }
 *     { type: 'join',   room }
 *     { type: 'leave',  room }
 *     { type: 'switch-active-room', room }
 *     { type: 'ping' }
 *
 *   Server → Client (`ServerMessage`):
 *     { type: 'logged-in',    username }
 *     { type: 'login-failed', reason }
 *     { type: 'rooms',   rooms }
 *     { type: 'history', room, messages }
 *     { type: 'message', room, from, text, ts }
 *     { type: 'users',   room, users }
 *     { type: 'system',  text }
 *
 * Auth model: until the first `login` frame arrives, the connection
 * is in `Unauthenticated` state and ignores everything else.  Once
 * `login` succeeds the server pushes `logged-in` + `rooms` + history
 * for every default room and the chat protocol becomes available.
 */

import type { RoomName } from './rooms.js';

export const WS_PATH = '/ws';

/** Single chat message — the read-model that goes over the wire. */
export interface ChatMessage {
  readonly from: string;
  readonly text: string;
  /** ms since epoch — server-side timestamp. */
  readonly ts: number;
}

/* --------------------------- Client → Server --------------------------- */

export type ClientMessage =
  | { readonly type: 'login';                readonly username: string; readonly password: string }
  | { readonly type: 'send';                 readonly room: RoomName;   readonly text: string }
  | { readonly type: 'join';                 readonly room: RoomName }
  | { readonly type: 'leave';                readonly room: RoomName }
  | { readonly type: 'switch-active-room';   readonly room: RoomName }
  | { readonly type: 'ping' };

/* --------------------------- Server → Client --------------------------- */

export type ServerMessage =
  | { readonly type: 'logged-in';     readonly username: string }
  | { readonly type: 'login-failed';  readonly reason: string }
  | { readonly type: 'rooms';         readonly rooms: ReadonlyArray<RoomName> }
  | { readonly type: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> }
  | { readonly type: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number }
  | { readonly type: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> }
  | { readonly type: 'system';        readonly text: string };

/* -------------------------- Encoding helpers -------------------------- */

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const v = JSON.parse(raw) as { readonly type?: unknown };
    if (typeof v.type !== 'string') return null;
    return v as ClientMessage;
  } catch {
    return null;
  }
}
