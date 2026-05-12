/**
 * Local mirror of `examples/chat/shared/protocol.ts`.  Each frontend
 * keeps a copy rather than reaching outside its source root — see
 * the chat sample's README for the rationale.
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
/** Since #100, `@<username>` is a DM "room" — a virtual room name. */
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
  | { readonly type: 'typing';               readonly room: RoomName }
  | { readonly type: 'read-up-to';           readonly room: RoomName; readonly ts: number }
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
  | { readonly type: 'user-typing';   readonly room: RoomName; readonly username: string }
  | { readonly type: 'read-receipts'; readonly room: RoomName; readonly receipts: Readonly<Record<string, number>> }
  | { readonly type: 'system';        readonly text: string };
