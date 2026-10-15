/**
 * Per-room online-users tracker, backed by DistributedData ORSets.
 *
 * **Why an actor wrapper around DD?**  DistributedData itself is a
 * synchronously-readable handle.  Adding a thin actor on top buys
 * three things:
 *
 *   1. Single place that serialises the per-room key naming
 *      (`online-users.<roomName>`).
 *   2. Subscriber fan-out: each `UserSessionActor` `Subscribe`s once
 *      per room they care about; the actor lazily attaches a single
 *      DD-level subscription per room and broadcasts every change to
 *      all interested sessions.  Avoids N DD subscribers per room.
 *      That subscription is this actor's own ref, so a change arrives
 *      as a `DistributedDataChanged` and the broadcast runs on this
 *      actor's turn, not on the replicator's.
 *   3. Lifecycle hygiene: when the last session unsubscribes from a
 *      room, the DD-level subscription is dropped too — clean
 *      resource teardown.
 *
 * **Per-room key**: each room is a separate DD entry rather than a
 * single nested `ORMap<RoomName, ORSet<username>>`.  Same eventual-
 * consistency guarantees, simpler API surface — there's no use-case
 * here that needs atomic visibility across rooms.
 */
import { match } from 'ts-pattern';
import { Actor, type ActorRef } from '../../../../src/index.js';
import { DistributedDataId, type DistributedDataChanged } from '../../../../src/crdt/index.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';
import { ORSet } from '../../../../src/crdt/ORSet.js';
import type { RoomName } from '../../shared/rooms.js';

/* --------------------------- public messages --------------------------- */

export type AddToRoomCommand      = { readonly kind: 'AddToRoom';      readonly room: RoomName; readonly username: string };
export type RemoveFromRoomCommand = { readonly kind: 'RemoveFromRoom'; readonly room: RoomName; readonly username: string };
export type SubscribeCommand      = { readonly kind: 'Subscribe';      readonly room: RoomName; readonly ref: ActorRef<UsersChanged> };
export type UnsubscribeCommand    = { readonly kind: 'Unsubscribe';    readonly room: RoomName; readonly ref: ActorRef<UsersChanged> };
export type GetUsersCommand       = { readonly kind: 'GetUsers';       readonly room: RoomName; readonly replyTo: ActorRef<UsersChanged> };

export type OnlineUsersCommand =
  | AddToRoomCommand
  | RemoveFromRoomCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | GetUsersCommand;

export type UsersChanged = {
  readonly kind: 'UsersChanged';
  readonly room: RoomName;
  readonly users: ReadonlyArray<string>;
};

/**
 * Everything this actor is told: the protocol above, plus the change
 * notifications of its own per-room subscriptions.  Spawned as this and
 * handed to sessions as {@link OnlineUsersCommand}.
 */
type OnlineUsersInbox = OnlineUsersCommand | DistributedDataChanged<ORSet<string>>;

/** DD key for a room's online-user set. */
function ddKey(room: RoomName): string {
  return `online-users.${room}`;
}

/* ------------------------------- internals ----------------------------- */

type RoomState = {
  /** The room this state's key belongs to — what a change is mapped back to. */
  readonly room: RoomName;
  readonly subscribers: Set<ActorRef<UsersChanged>>;
  ddUnsubscribe: (() => void) | null;
  /** Last known user list — what a session subscribing to the room is told first. */
  lastUsers: ReadonlyArray<string>;
};

/* ------------------------------- actor --------------------------------- */

export class OnlineUsersActor extends Actor<OnlineUsersInbox> {
  private dd!: DistributedDataHandle;
  private replicaId!: string;
  /** Per DD key, so a change notification finds its room by the key it carries. */
  private readonly rooms = new Map<string, RoomState>();

  override preStart(): void {
    // The DD extension must already have been started by main.ts
    // before any actor reaches here.  `.get()` throws otherwise — we
    // let it propagate via supervision rather than silently no-op.
    this.dd = this.system.extension(DistributedDataId).get();
    this.replicaId = this.dd.selfReplicaId();
  }

  override postStop(): void {
    for (const state of this.rooms.values()) {
      state.ddUnsubscribe?.();
    }
    this.rooms.clear();
  }

  override onReceive(message: OnlineUsersInbox): void {
    match(message)
      .with({ kind: 'AddToRoom' }, (m) => this.onAddToRoom(m))
      .with({ kind: 'RemoveFromRoom' }, (m) => this.onRemoveFromRoom(m))
      .with({ kind: 'Subscribe' }, (m) => this.onSubscribe(m))
      .with({ kind: 'Unsubscribe' }, (m) => this.onUnsubscribe(m))
      .with({ kind: 'GetUsers' }, (m) => this.onGetUsers(m))
      .with({ kind: 'distributed-data-changed' }, (m) => this.onDistributedDataChanged(m))
      .exhaustive();
  }

  /* ----------------------------- mutations ----------------------------- */

  private onAddToRoom(m: AddToRoomCommand): void {
    const { room, username } = m;
    this.dd.update<ORSet<string>>(
      ddKey(room),
      () => ORSet.empty<string>(),
      (current) => current.add(this.replicaId, username),
    );
  }

  private onRemoveFromRoom(m: RemoveFromRoomCommand): void {
    const { room, username } = m;
    this.dd.update<ORSet<string>>(
      ddKey(room),
      () => ORSet.empty<string>(),
      (current) => current.remove(username),
    );
  }

  /* ----------------------------- subscription -------------------------- */

  private onSubscribe(m: SubscribeCommand): void {
    const { room, ref } = m;
    const state = this.ensureRoomState(room);
    state.subscribers.add(ref);
    // Replay the last-known value to the new subscriber so they don't
    // wait for the next change to populate their UI.
    ref.tell({ kind: 'UsersChanged', room, users: state.lastUsers });
  }

  private onUnsubscribe(m: UnsubscribeCommand): void {
    const { room, ref } = m;
    const key = ddKey(room);
    const state = this.rooms.get(key);
    if (!state) return;
    state.subscribers.delete(ref);
    if (state.subscribers.size === 0) {
      // No locally interested sessions — drop the DD subscription too.
      state.ddUnsubscribe?.();
      this.rooms.delete(key);
    }
  }

  private onGetUsers(m: GetUsersCommand): void {
    const { room, replyTo } = m;
    const current = this.dd.get<ORSet<string>>(ddKey(room));
    const users = current ? [...current.value()] : [];
    replyTo.tell({ kind: 'UsersChanged', room, users });
  }

  private ensureRoomState(room: RoomName): RoomState {
    const key = ddKey(room);
    const existing = this.rooms.get(key);
    if (existing) return existing;
    // The subscription replays the key's value as a message, handled
    // after the `Subscribe` that got here — start from it now, or that
    // session would first be told an empty list.
    const current = this.dd.get<ORSet<string>>(key);
    const state: RoomState = {
      room,
      subscribers: new Set(),
      ddUnsubscribe: null,
      lastUsers: current ? [...current.value()] : [],
    };
    this.rooms.set(key, state);
    state.ddUnsubscribe = this.dd.subscribe<ORSet<string>>(key, this.self);
    return state;
  }

  /* ------------------------ DistributedData change --------------------- */

  /**
   * A room's key changed, told on this actor's turn.  A key with no state
   * here had its last session leave after this notification was queued:
   * the subscription ended with that session, and nobody is left to tell.
   */
  private onDistributedDataChanged(m: DistributedDataChanged<ORSet<string>>): void {
    const state = this.rooms.get(m.key);
    if (state === undefined) return;
    const users = [...m.value.value()];
    state.lastUsers = users;
    const event: UsersChanged = { kind: 'UsersChanged', room: state.room, users };
    for (const subscriber of state.subscribers) {
      try {
        subscriber.tell(event);
      } catch (e) {
        this.log.warn(`OnlineUsersActor: subscriber for ${state.room} threw`, e);
      }
    }
  }
}
