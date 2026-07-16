/**
 * Cluster-wide registry of chat rooms — added in #98.
 *
 * **Why an actor?**  DistributedData itself is a synchronously-
 * readable handle, but we want three things on top of the raw ORSet:
 *
 *   1. **Seed-on-empty**: on first start (when no node has populated
 *      the set yet), insert `DEFAULT_ROOMS`.  Subsequent restarts see
 *      the seeded set; idempotent re-add of the same names is a
 *      no-op for ORSet.
 *   2. **Subscriber fan-out**: each `UserSessionActor` `Subscribe`s
 *      once for its lifetime; this actor maintains a single DD-level
 *      subscription and broadcasts `RoomsChanged` to every interested
 *      session.  Avoids N DD subscribers cluster-wide.
 *   3. **Validation at the boundary**: `Create` rejects names that
 *      don't pass `isRoomName` so bad shapes never reach the ORSet.
 *
 * **Why no per-room access control?**  Out of scope today — the
 * sample's threat model is "anyone with a valid credential can use
 * any room".  Private rooms are a follow-up (filed as a TODO in the
 * #98 issue body's "Out of scope" section).
 *
 * **Why no delete?**  An ORSet supports `remove`, but the ChatRoom
 * actor's journal would orphan: the room name disappears from the
 * directory but its `chat-room-<name>` events stay in SQLite.  A
 * sensible delete needs journal-cleanup + history-archival, neither
 * of which is in scope for the sample.  The `RoomRemoved` event +
 * `room-removed` protocol frame are wired in case we add it later.
 */
import { match } from 'ts-pattern';
import { Actor, type ActorRef } from '../../../../src/index.js';
import { DistributedDataId } from '../../../../src/crdt/index.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';
import { ORSet } from '../../../../src/crdt/ORSet.js';
import { DEFAULT_ROOMS, isRoomName, type RoomName } from '../../shared/rooms.js';

/* --------------------------- public messages --------------------------- */

export interface CreateCommand      { readonly kind: 'Create';      readonly name: string;                          readonly replyTo?: ActorRef<CreateResult> }
export interface GetRoomsCommand    { readonly kind: 'GetRooms';    readonly replyTo: ActorRef<RoomsChanged> }
export interface SubscribeCommand   { readonly kind: 'Subscribe';   readonly ref: ActorRef<RoomsChanged | RoomAdded | RoomRemoved> }
export interface UnsubscribeCommand { readonly kind: 'Unsubscribe'; readonly ref: ActorRef<RoomsChanged | RoomAdded | RoomRemoved> }

export type ChatRoomDirectoryCommand =
  | CreateCommand
  | GetRoomsCommand
  | SubscribeCommand
  | UnsubscribeCommand;

export interface RoomsChanged {
  readonly kind: 'RoomsChanged';
  readonly rooms: ReadonlyArray<RoomName>;
}

export interface RoomAdded {
  readonly kind: 'RoomAdded';
  readonly name: RoomName;
}

export interface RoomRemoved {
  readonly kind: 'RoomRemoved';
  readonly name: RoomName;
}

export type CreateResult =
  | { readonly kind: 'CreateOk';      readonly name: RoomName }
  | { readonly kind: 'CreateRejected'; readonly reason: 'invalid-name' | 'already-exists' };

/** DD key for the cluster-wide room directory.  Single, well-known. */
export const ROOMS_DD_KEY = 'chat.rooms';

/* ------------------------------- actor --------------------------------- */

export class ChatRoomDirectoryActor extends Actor<ChatRoomDirectoryCommand> {
  private dd!: DistributedDataHandle;
  private replicaId!: string;
  private readonly subscribers = new Set<ActorRef<RoomsChanged | RoomAdded | RoomRemoved>>();
  private ddUnsubscribe: (() => void) | null = null;
  /** Last known room set — used to diff against incoming changes. */
  private lastRooms: ReadonlySet<RoomName> = new Set();

  override preStart(): void {
    this.dd = this.system.extension(DistributedDataId).get();
    this.replicaId = this.dd.selfReplicaId();

    // Subscribe to changes first — captures whatever the seed below
    // ends up writing, so subscribers don't miss the bootstrap.
    this.ddUnsubscribe = this.dd.subscribe<ORSet<string>>(ROOMS_DD_KEY, (next) => {
      this.onDdChange([...next.value()] as ReadonlyArray<RoomName>);
    });

    // Seed the default rooms.  ORSet.add is idempotent — re-adding an
    // existing name produces an equivalent CRDT value, gossip
    // converges to the same set.  Safe to run on every node, every
    // start.
    this.dd.update<ORSet<string>>(
      ROOMS_DD_KEY,
      () => ORSet.empty<string>(),
      (current) => {
        let next = current;
        for (const room of DEFAULT_ROOMS) {
          next = next.add(this.replicaId, room);
        }
        return next;
      },
    );

    // If the DD already had a value (we joined an existing cluster),
    // `subscribe` doesn't immediately fire — read it once so our
    // `lastRooms` reflects reality before any subscriber arrives.
    const initial = this.dd.get<ORSet<string>>(ROOMS_DD_KEY);
    if (initial !== undefined) {
      this.lastRooms = new Set(initial.value() as ReadonlyArray<RoomName>);
    }
  }

  override postStop(): void {
    this.ddUnsubscribe?.();
    this.subscribers.clear();
  }

  override onReceive(cmd: ChatRoomDirectoryCommand): void {
    match(cmd)
      .with({ kind: 'Create' },      (m) => this.onCreate(m))
      .with({ kind: 'GetRooms' },    (m) => this.onGetRooms(m))
      .with({ kind: 'Subscribe' },   (m) => this.onSubscribe(m))
      .with({ kind: 'Unsubscribe' }, (m) => this.onUnsubscribe(m))
      .exhaustive();
  }

  /* ----------------------------- mutations ----------------------------- */

  private onCreate(m: CreateCommand): void {
    const { name, replyTo } = m;
    if (!isRoomName(name)) {
      replyTo?.tell({ kind: 'CreateRejected', reason: 'invalid-name' });
      return;
    }
    if (this.lastRooms.has(name)) {
      // Idempotent at the data layer — re-add is a no-op — but the
      // caller probably wants to know they're racing another client.
      replyTo?.tell({ kind: 'CreateRejected', reason: 'already-exists' });
      return;
    }
    this.dd.update<ORSet<string>>(
      ROOMS_DD_KEY,
      () => ORSet.empty<string>(),
      (current) => current.add(this.replicaId, name),
    );
    replyTo?.tell({ kind: 'CreateOk', name });
  }

  /* ----------------------------- subscription -------------------------- */

  private onSubscribe(m: SubscribeCommand): void {
    const { ref } = m;
    this.subscribers.add(ref);
    // Replay the current set so the new subscriber doesn't wait for
    // the next change to populate their UI.
    ref.tell({ kind: 'RoomsChanged', rooms: [...this.lastRooms] });
  }

  private onUnsubscribe(m: UnsubscribeCommand): void {
    const { ref } = m;
    this.subscribers.delete(ref);
  }

  private onGetRooms(m: GetRoomsCommand): void {
    const { replyTo } = m;
    replyTo.tell({ kind: 'RoomsChanged', rooms: [...this.lastRooms] });
  }

  /* ----------------------------- DD callback --------------------------- */

  private onDdChange(nextRooms: ReadonlyArray<RoomName>): void {
    const nextSet = new Set(nextRooms);

    // Diff against the previous snapshot.  ORSet's wire format
    // doesn't tell us "what changed" — we compute it locally so the
    // protocol can carry add/remove notifications instead of forcing
    // every client to compare two lists.
    const added: RoomName[] = [];
    const removed: RoomName[] = [];
    for (const name of nextSet) {
      if (!this.lastRooms.has(name)) added.push(name);
    }
    for (const name of this.lastRooms) {
      if (!nextSet.has(name)) removed.push(name);
    }
    this.lastRooms = nextSet;

    // Always fan out the full set (cheap; new subscribers also get
    // this), AND per-name notifications so frontends can show
    // toast-style notifications.
    const fullEvent: RoomsChanged = { kind: 'RoomsChanged', rooms: [...nextSet] };
    for (const sub of this.subscribers) {
      try {
        sub.tell(fullEvent);
        for (const name of added)   sub.tell({ kind: 'RoomAdded', name });
        for (const name of removed) sub.tell({ kind: 'RoomRemoved', name });
      } catch (e) {
        this.log.warn(`ChatRoomDirectory: subscriber threw`, e);
      }
    }
  }
}
