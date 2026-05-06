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
  | { readonly type: 'login';   readonly username: string; readonly password: string }
  | { readonly type: 'resume';  readonly token: string }
  | { readonly type: 'logout' }
  | { readonly type: 'ping' }
  | { readonly type: 'voice-target'; readonly mode: 'peer';  readonly target: Username }
  | { readonly type: 'voice-target'; readonly mode: 'group'; readonly group:  GroupName }
  | { readonly type: 'voice-target'; readonly mode: 'room';  readonly room:   VoiceRoomName }
  | { readonly type: 'voice-stop' }
  | { readonly type: 'room-enter'; readonly room: VoiceRoomName }
  | { readonly type: 'room-leave'; readonly room: VoiceRoomName };

export type ServerMessage =
  | { readonly type: 'logged-in';    readonly username: Username; readonly token: string }
  | { readonly type: 'login-failed'; readonly reason: string }
  | { readonly type: 'system';       readonly text: string }
  | { readonly type: 'directory';
      readonly users:  ReadonlyArray<Username>;
      readonly groups: ReadonlyArray<GroupSummary>;
      readonly rooms:  ReadonlyArray<VoiceRoomName> }
  | { readonly type: 'online-users';      readonly users: ReadonlyArray<Username> }
  | { readonly type: 'room-participants'; readonly room: VoiceRoomName;
                                          readonly users: ReadonlyArray<Username> }
  | { readonly type: 'voice-target-ok';     readonly mode: 'peer'|'group'|'room';
                                            readonly key: string }
  | { readonly type: 'voice-target-failed'; readonly mode: 'peer'|'group'|'room';
                                            readonly key: string;
                                            readonly reason: string }
  | { readonly type: 'voice-incoming-start';
      readonly from: Username; readonly source: IncomingSource }
  | { readonly type: 'voice-incoming-end'; readonly from: Username };

export function decodeIncomingFrame(buf: Uint8Array): { sender: string; opus: Uint8Array } | null {
  if (buf.byteLength < 1) return null;
  const nameLen = buf[0]!;
  if (buf.byteLength < 1 + nameLen) return null;
  const sender = new TextDecoder().decode(buf.subarray(1, 1 + nameLen));
  const opus = buf.subarray(1 + nameLen);
  return { sender, opus };
}
