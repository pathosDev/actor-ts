/**
 * Predefined voice rooms.  Static list, like {@link GROUPS} — keeps
 * the sample focused on cluster mechanics rather than room CRUD.
 *
 * Room *membership* is dynamic and lives in DistributedData
 * (`voice.room-users.<name>` ORSet).  Only the *roster* of available
 * rooms is fixed here.
 */

export const VOICE_ROOMS = ['lobby', 'standup', 'all-hands'] as const;
export type VoiceRoomName = (typeof VOICE_ROOMS)[number];

export function isVoiceRoomName(s: unknown): s is VoiceRoomName {
  return typeof s === 'string' && (VOICE_ROOMS as ReadonlyArray<string>).includes(s);
}
