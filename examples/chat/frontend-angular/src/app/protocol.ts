/**
 * Local mirror of `examples/chat/shared/protocol.ts`.
 *
 * The Angular build is rooted under `frontend-angular/` so reaching
 * up into `../shared/` from inside `tsconfig.app.json` would require
 * loosening `rootDir` and `strict` settings the Angular compiler
 * relies on.  Duplicating the (small, stable) type set keeps the
 * Angular project self-contained — the cost is one place to update
 * if the protocol changes.
 */

export const DEFAULT_ROOMS = [
  'general',
  'random',
  'tech',
  'announcements',
] as const;
/**
 * Since #98, rooms can be created at runtime via `create-room` and
 * the cluster broadcasts the resulting `room-added`/`room-removed`
 * frames.  `RoomName` is therefore a generic string with a runtime
 * shape guard — `isRoomName` mirrors the server's `shared/rooms.ts`.
 */
export type RoomName = string;

const ROOM_BODY = /[A-Za-z0-9][A-Za-z0-9_-]{0,31}/;
const ROOM_NAME_PATTERN = new RegExp(`^@?${ROOM_BODY.source}$`);
export function isRoomName(s: unknown): s is RoomName {
  return typeof s === 'string' && ROOM_NAME_PATTERN.test(s);
}
/** Since #100, `@<username>` is a DM "room" — a virtual room name
 *  used for client-side display and routing of direct messages.
 *  Server distinguishes by the leading `@`. */
export function isDmRoom(r: unknown): r is RoomName {
  return typeof r === 'string' && r.startsWith('@') && r.length > 1;
}
export const dmRoomFor = (otherUser: string): RoomName => `@${otherUser}`;

export const WS_PATH = '/ws';

export interface ChatMessage {
  readonly from: string;
  readonly text: string;
  readonly ts: number;
}

export type ClientMessage =
  | { readonly type: 'login';                readonly username: string; readonly password: string }
  | { readonly type: 'resume';               readonly token: string }
  | { readonly type: 'logout' }
  | { readonly type: 'send';                 readonly room: RoomName;   readonly text: string }
  | { readonly type: 'join';                 readonly room: RoomName }
  | { readonly type: 'leave';                readonly room: RoomName }
  | { readonly type: 'switch-active-room';   readonly room: RoomName }
  | { readonly type: 'create-room';          readonly name: string }
  | { readonly type: 'ping' };

export type ServerMessage =
  | { readonly type: 'logged-in';     readonly username: string; readonly token: string }
  | { readonly type: 'login-failed';  readonly reason: string }
  | { readonly type: 'rooms';         readonly rooms: ReadonlyArray<RoomName> }
  | { readonly type: 'room-added';    readonly name: RoomName }
  | { readonly type: 'room-removed';  readonly name: RoomName }
  | { readonly type: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> }
  | { readonly type: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number }
  | { readonly type: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> }
  | { readonly type: 'system';        readonly text: string };
