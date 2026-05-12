/**
 * Wire-format definitions shared between the chat backend and every
 * frontend (plain HTML, Angular, React, Next.js, SvelteKit, Lit).
 *
 * The protocol is a single bidirectional stream of JSON-encoded
 * frames over `/ws`.  No REST endpoints — login, history, message
 * send, and presence updates all flow through this channel.
 *
 *   Client → Server (`ClientMessage`):
 *     { type: 'login',  username, password }
 *     { type: 'resume', token }                // alt. to login on reconnect
 *     { type: 'logout' }                       // explicit log-out + revoke
 *     { type: 'send',   room, text }
 *     { type: 'join',   room }
 *     { type: 'leave',  room }
 *     { type: 'switch-active-room', room }
 *     { type: 'create-room', name }            // #98 — runtime room creation
 *     { type: 'typing',  room }                // #103 — ephemeral typing indicator
 *     { type: 'ping' }
 *
 *   Server → Client (`ServerMessage`):
 *     { type: 'logged-in',    username, token }
 *     { type: 'login-failed', reason }
 *     { type: 'rooms',        rooms }
 *     { type: 'room-added',   name }           // #98 — broadcast on room creation
 *     { type: 'room-removed', name }           // #98 — reserved (delete is out-of-scope today)
 *     { type: 'history',      room, messages }
 *     { type: 'message',      room, from, text, ts }
 *     { type: 'users',        room, users }
 *     { type: 'user-typing',  room, username } // #103 — broadcast on `typing` frame
 *     { type: 'system',       text }
 *
 * Auth model: the first frame on any new socket is either `login`
 * (with credentials) or `resume` (with a token previously issued via
 * `logged-in`).  Until that frame succeeds the connection sits in
 * `Unauthenticated` state and ignores everything else.  Successful
 * auth pushes `logged-in` (carrying the session token the client
 * should persist), then `rooms`, then per-room history/users frames.
 *
 * Tokens are issued on login, persisted cluster-wide via
 * DistributedData (so they survive a singleton failover), and
 * revoked on `logout`.  TTL is bounded server-side; a stale token
 * simply yields `login-failed`.  Clients clear their stored token
 * on `login-failed` and fall back to the credentials form.
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
  | { readonly type: 'resume';               readonly token: string }
  | { readonly type: 'logout' }
  | { readonly type: 'send';                 readonly room: RoomName;   readonly text: string }
  | { readonly type: 'join';                 readonly room: RoomName }
  | { readonly type: 'leave';                readonly room: RoomName }
  | { readonly type: 'switch-active-room';   readonly room: RoomName }
  | { readonly type: 'create-room';          readonly name: string }
  | { readonly type: 'typing';               readonly room: RoomName }
  | { readonly type: 'ping' };

/* --------------------------- Server → Client --------------------------- */

export type ServerMessage =
  | { readonly type: 'logged-in';     readonly username: string; readonly token: string }
  | { readonly type: 'login-failed';  readonly reason: string }
  | { readonly type: 'rooms';         readonly rooms: ReadonlyArray<RoomName> }
  | { readonly type: 'room-added';    readonly name: RoomName }
  | { readonly type: 'room-removed';  readonly name: RoomName }
  | { readonly type: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> }
  | { readonly type: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number }
  | { readonly type: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> }
  | { readonly type: 'user-typing';   readonly room: RoomName; readonly username: string }
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
