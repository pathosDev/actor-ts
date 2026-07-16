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
 *     { type: 'read-up-to', room, ts }         // #103 — mark messages up to `ts` read
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
 *     { type: 'read-receipts',room, receipts } // #103 — read pointers per username
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

export type LoginMessage           = { readonly type: 'login';              readonly username: string; readonly password: string };
export type ResumeMessage          = { readonly type: 'resume';             readonly token: string };
export type LogoutMessage          = { readonly type: 'logout' };
export type SendMessage            = { readonly type: 'send';               readonly room: RoomName;   readonly text: string };
export type JoinMessage            = { readonly type: 'join';               readonly room: RoomName };
export type LeaveMessage           = { readonly type: 'leave';              readonly room: RoomName };
export type SwitchActiveRoomMessage = { readonly type: 'switch-active-room'; readonly room: RoomName };
export type CreateRoomMessage      = { readonly type: 'create-room';        readonly name: string };
export type TypingMessage          = { readonly type: 'typing';             readonly room: RoomName };
export type ReadUpToMessage        = { readonly type: 'read-up-to';         readonly room: RoomName; readonly ts: number };
export type PingMessage            = { readonly type: 'ping' };

export type ClientMessage =
  | LoginMessage
  | ResumeMessage
  | LogoutMessage
  | SendMessage
  | JoinMessage
  | LeaveMessage
  | SwitchActiveRoomMessage
  | CreateRoomMessage
  | TypingMessage
  | ReadUpToMessage
  | PingMessage;

/* --------------------------- Server → Client --------------------------- */

export type LoggedInMessage     = { readonly type: 'logged-in';     readonly username: string; readonly token: string };
export type LoginFailedMessage  = { readonly type: 'login-failed';  readonly reason: string };
export type RoomsMessage        = { readonly type: 'rooms';         readonly rooms: ReadonlyArray<RoomName> };
export type RoomAddedMessage    = { readonly type: 'room-added';    readonly name: RoomName };
export type RoomRemovedMessage  = { readonly type: 'room-removed';  readonly name: RoomName };
export type HistoryMessage      = { readonly type: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> };
export type RoomMessage         = { readonly type: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number };
export type UsersMessage        = { readonly type: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> };
export type UserTypingMessage   = { readonly type: 'user-typing';   readonly room: RoomName; readonly username: string };
export type ReadReceiptsMessage = { readonly type: 'read-receipts'; readonly room: RoomName; readonly receipts: Readonly<Record<string, number>> };
export type SystemMessage       = { readonly type: 'system';        readonly text: string };

export type ServerMessage =
  | LoggedInMessage
  | LoginFailedMessage
  | RoomsMessage
  | RoomAddedMessage
  | RoomRemovedMessage
  | HistoryMessage
  | RoomMessage
  | UsersMessage
  | UserTypingMessage
  | ReadReceiptsMessage
  | SystemMessage;

/* -------------------------- Encoding helpers -------------------------- */

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as { readonly type?: unknown };
    if (typeof parsed.type !== 'string') return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}
