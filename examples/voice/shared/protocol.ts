/**
 * Wire protocol for the voice sample.  Mirrors the chat sample's
 * style — JSON discriminated unions on text frames, with three
 * additions:
 *
 *   - `voice-target` / `voice-stop` — control plane that tells the
 *     server where the next batch of binary audio frames should be
 *     routed (peer / group / room).  Set once on PTT-down,
 *     cleared once on PTT-up.
 *   - `room-enter` / `room-leave` — room membership, orthogonal to
 *     `voice-target`: entering a room subscribes you to its audio
 *     topic, but you don't speak until you also send `voice-target
 *     { mode: 'room' }`.
 *   - `voice-incoming-start` / `voice-incoming-end` — frame
 *     boundaries for the receiver's playback module.  Each
 *     `voice-incoming-start` corresponds to a fresh `MediaSource`
 *     instance on the client (because every PTT press starts a new
 *     `MediaRecorder` run, which carries its own EBML init segment;
 *     the receiver MUST tear down and re-create the playback
 *     pipeline per stream to keep them in sync).
 *
 * **Audio data is NOT a ServerMessage variant** — it travels as
 * binary WS frames using the `frameCodec` envelope.
 *
 * The auth path (login / resume / logout / token-handling) is byte-
 * identical to the chat sample.  We deliberately keep the same
 * `TOKEN_KEY` shape so `SessionStore` plumbing can be reused.
 */

import type { GroupName } from './groups.js';
import type { VoiceRoomName } from './rooms.js';

export const WS_PATH = '/ws';

export type Username = string;

/* ============================================================== */
/* Client → Server                                                  */
/* ============================================================== */

/* — auth (identical to chat) — */

export type LoginMessage = {
  readonly kind: 'login';
  readonly username: string;
  readonly password: string;
};
export type ResumeMessage = {
  readonly kind: 'resume';
  readonly token: string;
};
export type LogoutMessage = {
  readonly kind: 'logout';
};
export type PingMessage = {
  readonly kind: 'ping';
};

/* — voice control plane — */

export type VoiceTargetPeerMessage = {
  readonly kind: 'voice-target';
  readonly mode: 'peer';
  readonly target: Username;
};
export type VoiceTargetGroupMessage = {
  readonly kind: 'voice-target';
  readonly mode: 'group';
  readonly group: GroupName;
};
export type VoiceTargetRoomMessage = {
  readonly kind: 'voice-target';
  readonly mode: 'room';
  readonly room: VoiceRoomName;
};
export type VoiceStopMessage = {
  readonly kind: 'voice-stop';
};

/* — room membership — */

export type RoomEnterMessage = {
  readonly kind: 'room-enter';
  readonly room: VoiceRoomName;
};
export type RoomLeaveMessage = {
  readonly kind: 'room-leave';
  readonly room: VoiceRoomName;
};

export type ClientMessage =
  // — auth (identical to chat) —
  | LoginMessage
  | ResumeMessage
  | LogoutMessage
  | PingMessage

  // — voice control plane —
  | VoiceTargetPeerMessage
  | VoiceTargetGroupMessage
  | VoiceTargetRoomMessage
  | VoiceStopMessage

  // — room membership —
  | RoomEnterMessage
  | RoomLeaveMessage;

/* ============================================================== */
/* Server → Client                                                  */
/* ============================================================== */

export interface GroupSummary {
  readonly name: GroupName;
  readonly members: ReadonlyArray<Username>;
}

export type IncomingSource =
  | { readonly kind: 'peer' }
  | { readonly kind: 'group'; readonly group: GroupName }
  | { readonly kind: 'room';  readonly room:  VoiceRoomName };

export type ServerMessage =
  // — auth (identical to chat) —
  | { readonly kind: 'logged-in';    readonly username: Username; readonly token: string }
  | { readonly kind: 'login-failed'; readonly reason: string }
  | { readonly kind: 'system';       readonly text: string }

  // — initial directory snapshot, sent once after login —
  | {
      readonly kind: 'directory';
      readonly users:  ReadonlyArray<Username>;
      readonly groups: ReadonlyArray<GroupSummary>;
      readonly rooms:  ReadonlyArray<VoiceRoomName>;
    }

  // — live updates —
  | { readonly kind: 'online-users';      readonly users: ReadonlyArray<Username> }
  | { readonly kind: 'room-participants'; readonly room: VoiceRoomName;
                                          readonly users: ReadonlyArray<Username> }

  // — voice control echoes —
  | { readonly kind: 'voice-target-ok';     readonly mode: 'peer'|'group'|'room';
                                            readonly key: string }
  | { readonly kind: 'voice-target-failed'; readonly mode: 'peer'|'group'|'room';
                                            readonly key: string;
                                            readonly reason: string }

  // — incoming-stream framing for the playback module —
  | { readonly kind: 'voice-incoming-start';
      readonly from: Username;
      readonly source: IncomingSource }
  | { readonly kind: 'voice-incoming-end';
      readonly from: Username };

/* ============================================================== */
/* Encoding helpers                                                 */
/* ============================================================== */

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    if (typeof parsed?.kind !== 'string') return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}
