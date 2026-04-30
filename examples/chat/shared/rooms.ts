/**
 * Hardcoded chat rooms.  Phase-1 simplification — Phase 2 would
 * replace this with a `ChatRoomDirectoryActor` backed by an
 * ORSet<RoomName> in DistributedData so users can create rooms at
 * runtime.  The static list keeps the sample focused on the
 * sharding-+-persistence-+-pubsub trinity rather than CRUD plumbing.
 *
 * Every room becomes a sharded `ChatRoomActor` entity (keyed on
 * `entityId = roomName`).  `persistenceId` is `chat-room-<roomName>`
 * — events for different rooms live in disjoint streams in the
 * SQLite journal.
 */
export const DEFAULT_ROOMS = [
  'general',
  'random',
  'tech',
  'announcements',
] as const;

export type RoomName = (typeof DEFAULT_ROOMS)[number];

/** Type-guard for narrowing untrusted strings (e.g. WS frames). */
export function isRoomName(s: unknown): s is RoomName {
  return typeof s === 'string' && (DEFAULT_ROOMS as readonly string[]).includes(s);
}
