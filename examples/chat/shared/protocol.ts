/**
 * Wire-format definitions shared between the chat backend and every
 * frontend (plain HTML, Angular, React, Next.js, SvelteKit, Lit).
 *
 * The protocol is a single bidirectional stream of JSON-encoded
 * frames over `/ws`.  No REST endpoints — login, history, message
 * send, and presence updates all flow through this channel.
 *
 *   Client → Server (`ClientMessage`):
 *     { kind: 'login',  username, password }
 *     { kind: 'resume', token }                // alt. to login on reconnect
 *     { kind: 'logout' }                       // explicit log-out + revoke
 *     { kind: 'send',   room, text }
 *     { kind: 'join',   room }
 *     { kind: 'leave',  room }
 *     { kind: 'switch-active-room', room }
 *     { kind: 'create-room', name }            // #98 — runtime room creation
 *     { kind: 'typing',  room }                // #103 — ephemeral typing indicator
 *     { kind: 'read-up-to', room, ts }         // #103 — mark messages up to `ts` read
 *     { kind: 'ping' }
 *
 *   Server → Client (`ServerMessage`):
 *     { kind: 'logged-in',    username, token }
 *     { kind: 'login-failed', reason }
 *     { kind: 'rooms',        rooms }
 *     { kind: 'room-added',   name }           // #98 — broadcast on room creation
 *     { kind: 'room-removed', name }           // #98 — reserved (delete is out-of-scope today)
 *     { kind: 'history',      room, messages }
 *     { kind: 'message',      room, from, text, ts }
 *     { kind: 'users',        room, users }
 *     { kind: 'user-typing',  room, username } // #103 — broadcast on `typing` frame
 *     { kind: 'read-receipts',room, receipts } // #103 — read pointers per username
 *     { kind: 'system',       text }
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

export type LoginMessage           = { readonly kind: 'login';              readonly username: string; readonly password: string };
export type ResumeMessage          = { readonly kind: 'resume';             readonly token: string };
export type LogoutMessage          = { readonly kind: 'logout' };
export type SendMessage            = { readonly kind: 'send';               readonly room: RoomName;   readonly text: string };
export type JoinMessage            = { readonly kind: 'join';               readonly room: RoomName };
export type LeaveMessage           = { readonly kind: 'leave';              readonly room: RoomName };
export type SwitchActiveRoomMessage = { readonly kind: 'switch-active-room'; readonly room: RoomName };
export type CreateRoomMessage      = { readonly kind: 'create-room';        readonly name: string };
export type TypingMessage          = { readonly kind: 'typing';             readonly room: RoomName };
export type ReadUpToMessage        = { readonly kind: 'read-up-to';         readonly room: RoomName; readonly ts: number };
export type PingMessage            = { readonly kind: 'ping' };

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

export type LoggedInMessage     = { readonly kind: 'logged-in';     readonly username: string; readonly token: string };
export type LoginFailedMessage  = { readonly kind: 'login-failed';  readonly reason: string };
export type RoomsMessage        = { readonly kind: 'rooms';         readonly rooms: ReadonlyArray<RoomName> };
export type RoomAddedMessage    = { readonly kind: 'room-added';    readonly name: RoomName };
export type RoomRemovedMessage  = { readonly kind: 'room-removed';  readonly name: RoomName };
export type HistoryMessage      = { readonly kind: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> };
export type RoomMessage         = { readonly kind: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number };
export type UsersMessage        = { readonly kind: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> };
export type UserTypingMessage   = { readonly kind: 'user-typing';   readonly room: RoomName; readonly username: string };
export type ReadReceiptsMessage = { readonly kind: 'read-receipts'; readonly room: RoomName; readonly receipts: Readonly<Record<string, number>> };
export type SystemMessage       = { readonly kind: 'system';        readonly text: string };

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
    const parsed = JSON.parse(raw) as { readonly kind?: unknown };
    if (typeof parsed.kind !== 'string') return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}
