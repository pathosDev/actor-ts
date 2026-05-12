/**
 * Room registry — dynamic since #98.
 *
 * `RoomName` is now an opaque alias for `string`: the runtime list of
 * rooms lives in a `DistributedData`-backed `ORSet<RoomName>` managed
 * by `ChatRoomDirectoryActor`, not in this file's static array.
 *
 * `DEFAULT_ROOMS` is kept as the **seed list** that the directory
 * actor adds on first start.  After that, users can create new rooms
 * at runtime; deletion is intentionally still out of scope (the
 * journal would orphan otherwise).
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

/**
 * A room name is any reasonably-shaped string.  We don't constrain it
 * to the default list any more (would defeat the point of dynamic
 * rooms), but we DO require it to be safe to use as:
 *   - a `ChatRoomActor` entity id (shard key)
 *   - a `persistenceId` suffix (`chat-room-<name>`)
 *   - a `DistributedPubSub` topic suffix (`chat.room.<name>`)
 *   - a URL/path segment if anyone wires routes around it
 *
 * Allowed: `[a-zA-Z0-9_-]`, length 1–32.  Lowercase encouraged but
 * not enforced.  Rejects whitespace, dots, slashes, and control
 * chars — the same shape Memcached / FS-backend keys enforce
 * (see `src/persistence/storage/KeyValidator.ts`).
 */
export type RoomName = string;

const ROOM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Type-guard for narrowing untrusted strings (e.g. WS frames). */
export function isRoomName(s: unknown): s is RoomName {
  return typeof s === 'string' && ROOM_NAME_PATTERN.test(s);
}
