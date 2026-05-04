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
export type RoomName = (typeof DEFAULT_ROOMS)[number];

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
  | { readonly type: 'ping' };

export type ServerMessage =
  | { readonly type: 'logged-in';     readonly username: string; readonly token: string }
  | { readonly type: 'login-failed';  readonly reason: string }
  | { readonly type: 'rooms';         readonly rooms: ReadonlyArray<RoomName> }
  | { readonly type: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> }
  | { readonly type: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number }
  | { readonly type: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> }
  | { readonly type: 'system';        readonly text: string };
