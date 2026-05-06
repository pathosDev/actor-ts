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

export type ClientMessage =
  // — auth (identical to chat) —
  | { readonly type: 'login';   readonly username: string; readonly password: string }
  | { readonly type: 'resume';  readonly token: string }
  | { readonly type: 'logout' }
  | { readonly type: 'ping' }

  // — voice control plane —
  | { readonly type: 'voice-target'; readonly mode: 'peer';  readonly target: Username  }
  | { readonly type: 'voice-target'; readonly mode: 'group'; readonly group:  GroupName }
  | { readonly type: 'voice-target'; readonly mode: 'room';  readonly room:   VoiceRoomName }
  | { readonly type: 'voice-stop' }

  // — room membership —
  | { readonly type: 'room-enter'; readonly room: VoiceRoomName }
  | { readonly type: 'room-leave'; readonly room: VoiceRoomName };

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
  | { readonly type: 'logged-in';    readonly username: Username; readonly token: string }
  | { readonly type: 'login-failed'; readonly reason: string }
  | { readonly type: 'system';       readonly text: string }

  // — initial directory snapshot, sent once after login —
  | {
      readonly type: 'directory';
      readonly users:  ReadonlyArray<Username>;
      readonly groups: ReadonlyArray<GroupSummary>;
      readonly rooms:  ReadonlyArray<VoiceRoomName>;
    }

  // — live updates —
  | { readonly type: 'online-users';      readonly users: ReadonlyArray<Username> }
  | { readonly type: 'room-participants'; readonly room: VoiceRoomName;
                                          readonly users: ReadonlyArray<Username> }

  // — voice control echoes —
  | { readonly type: 'voice-target-ok';     readonly mode: 'peer'|'group'|'room';
                                            readonly key: string }
  | { readonly type: 'voice-target-failed'; readonly mode: 'peer'|'group'|'room';
                                            readonly key: string;
                                            readonly reason: string }

  // — incoming-stream framing for the playback module —
  | { readonly type: 'voice-incoming-start';
      readonly from: Username;
      readonly source: IncomingSource }
  | { readonly type: 'voice-incoming-end';
      readonly from: Username };

/* ============================================================== */
/* Encoding helpers                                                 */
/* ============================================================== */

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (typeof parsed?.type !== 'string') return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}
