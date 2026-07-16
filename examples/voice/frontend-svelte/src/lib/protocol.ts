/**
 * Local mirror of `examples/voice/shared/protocol.ts`.  Each
 * build-based frontend keeps its own copy rather than reaching
 * outside its source root — see the voice sample's README for
 * the rationale (same pattern as the chat sample).
 */

export const WS_PATH = '/ws';
export const TIMESLICE_MS = 100;
export const MIME_OPUS = 'audio/webm; codecs=opus';

export type Username = string;
export type GroupName = 'engineering' | 'ops' | 'product';
export type VoiceRoomName = 'lobby' | 'standup' | 'all-hands';

export interface GroupSummary {
  readonly name: GroupName;
  readonly members: ReadonlyArray<Username>;
}

export type IncomingSource =
  | { readonly kind: 'peer' }
  | { readonly kind: 'group'; readonly group: GroupName }
  | { readonly kind: 'room';  readonly room:  VoiceRoomName };

export type ClientMessage =
  | { readonly kind: 'login';   readonly username: string; readonly password: string }
  | { readonly kind: 'resume';  readonly token: string }
  | { readonly kind: 'logout' }
  | { readonly kind: 'ping' }
  | { readonly kind: 'voice-target'; readonly mode: 'peer';  readonly target: Username }
  | { readonly kind: 'voice-target'; readonly mode: 'group'; readonly group:  GroupName }
  | { readonly kind: 'voice-target'; readonly mode: 'room';  readonly room:   VoiceRoomName }
  | { readonly kind: 'voice-stop' }
  | { readonly kind: 'room-enter'; readonly room: VoiceRoomName }
  | { readonly kind: 'room-leave'; readonly room: VoiceRoomName };

export type ServerMessage =
  | { readonly kind: 'logged-in';    readonly username: Username; readonly token: string }
  | { readonly kind: 'login-failed'; readonly reason: string }
  | { readonly kind: 'system';       readonly text: string }
  | { readonly kind: 'directory';
      readonly users:  ReadonlyArray<Username>;
      readonly groups: ReadonlyArray<GroupSummary>;
      readonly rooms:  ReadonlyArray<VoiceRoomName> }
  | { readonly kind: 'online-users';      readonly users: ReadonlyArray<Username> }
  | { readonly kind: 'room-participants'; readonly room: VoiceRoomName;
                                          readonly users: ReadonlyArray<Username> }
  | { readonly kind: 'voice-target-ok';     readonly mode: 'peer'|'group'|'room';
                                            readonly key: string }
  | { readonly kind: 'voice-target-failed'; readonly mode: 'peer'|'group'|'room';
                                            readonly key: string;
                                            readonly reason: string }
  | { readonly kind: 'voice-incoming-start';
      readonly from: Username; readonly source: IncomingSource }
  | { readonly kind: 'voice-incoming-end'; readonly from: Username };

export function decodeIncomingFrame(buf: Uint8Array): { sender: string; opus: Uint8Array } | null {
  if (buf.byteLength < 1) return null;
  const nameLen = buf[0]!;
  if (buf.byteLength < 1 + nameLen) return null;
  const sender = new TextDecoder().decode(buf.subarray(1, 1 + nameLen));
  const opus = buf.subarray(1 + nameLen);
  return { sender, opus };
}
