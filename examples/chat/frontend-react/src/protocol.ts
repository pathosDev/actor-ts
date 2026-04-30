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
export type RoomName = (typeof DEFAULT_ROOMS)[number];

export const WS_PATH = '/ws';

export interface ChatMessage {
  readonly from: string;
  readonly text: string;
  readonly ts: number;
}

export type ClientMessage =
  | { readonly type: 'login';                readonly username: string; readonly password: string }
  | { readonly type: 'send';                 readonly room: RoomName;   readonly text: string }
  | { readonly type: 'join';                 readonly room: RoomName }
  | { readonly type: 'leave';                readonly room: RoomName }
  | { readonly type: 'switch-active-room';   readonly room: RoomName }
  | { readonly type: 'ping' };

export type ServerMessage =
  | { readonly type: 'logged-in';     readonly username: string }
  | { readonly type: 'login-failed';  readonly reason: string }
  | { readonly type: 'rooms';         readonly rooms: ReadonlyArray<RoomName> }
  | { readonly type: 'history';       readonly room: RoomName; readonly messages: ReadonlyArray<ChatMessage> }
  | { readonly type: 'message';       readonly room: RoomName; readonly from: string; readonly text: string; readonly ts: number }
  | { readonly type: 'users';         readonly room: RoomName; readonly users: ReadonlyArray<string> }
  | { readonly type: 'system';        readonly text: string };
