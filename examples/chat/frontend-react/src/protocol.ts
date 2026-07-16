/**
 * Local mirror of `examples/chat/shared/protocol.ts`.
 *
 * Vite picks up source files via its `include`-from-tsconfig glob.
 * Reaching outside the React project's source root would push the
 * `tsconfig.json`'s `rootDir` into territory the type-checker
 * doesn't expect; duplicating the (small, stable) protocol set
 * keeps each frontend self-contained — same trade-off as the other
 * frontends.
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
 *  used for client-side display and routing of direct messages. */
export function isDirectMessageRoom(r: unknown): r is RoomName {
  return typeof r === 'string' && r.startsWith('@') && r.length > 1;
}
export const directMessageRoomFor = (otherUser: string): RoomName => `@${otherUser}`;

export const WS_PATH = '/ws';

export interface ChatMessage {
  readonly from: string;
  readonly text: string;
  readonly ts: number;
}

export type ClientMessage =
  | { readonly kind: 'login';                readonly username: string; readonly password: string }
  | { readonly kind: 'resume';               readonly token: string }
  | { readonly kind: 'logout' }
  | { readonly kind: 'send';                 readonly room: RoomName;   readonly text: string }
  | { readonly kind: 'join';                 readonly room: RoomName }
  | { readonly kind: 'leave';                readonly room: RoomName }
  | { readonly kind: 'switch-active-room';   readonly room: RoomName }
  | { readonly kind: 'create-room';          readonly name: string }
  | { readonly kind: 'typing';               readonly room: RoomName }
  | { readonly kind: 'read-up-to';           readonly room: RoomName; readonly ts: number }
  | { readonly kind: 'ping' };

export type ServerMessage =
  | { readonly kind: 'logged-in';     readonly username: string; readonly token: string }
  | { readonly kind: 'login-failed';  readonly reason: string }
  | { readonly kind: 'rooms';         readonly rooms: ReadonlyArray<RoomName> }
  | { readonly kind: 'room-added';    readonly name: RoomName }
  | { readonly kind: 'room-removed';  readonly name: RoomName }
  | { readonly kind: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> }
  | { readonly kind: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number }
  | { readonly kind: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> }
  | { readonly kind: 'user-typing';   readonly room: RoomName; readonly username: string }
  | { readonly kind: 'read-receipts'; readonly room: RoomName; readonly receipts: Readonly<Record<string, number>> }
  | { readonly kind: 'system';        readonly text: string };
