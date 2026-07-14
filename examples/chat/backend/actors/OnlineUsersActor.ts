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
import { DistributedDataId } from '../../../../src/crdt/index.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';
import { ORSet } from '../../../../src/crdt/ORSet.js';
import type { RoomName } from '../../shared/rooms.js';

/* --------------------------- public messages --------------------------- */

export type OnlineUsersCommand =
  | { readonly kind: 'AddToRoom';      readonly room: RoomName; readonly username: string }
  | { readonly kind: 'RemoveFromRoom'; readonly room: RoomName; readonly username: string }
  | { readonly kind: 'Subscribe';      readonly room: RoomName; readonly ref: ActorRef<UsersChanged> }
  | { readonly kind: 'Unsubscribe';    readonly room: RoomName; readonly ref: ActorRef<UsersChanged> }
  | { readonly kind: 'GetUsers';       readonly room: RoomName; readonly replyTo: ActorRef<UsersChanged> };

export interface UsersChanged {
  readonly kind: 'UsersChanged';
  readonly room: RoomName;
  readonly users: ReadonlyArray<string>;
}

/** DD key for a room's online-user set. */
function ddKey(room: RoomName): string {
  return `online-users.${room}`;
}

/* ------------------------------- internals ----------------------------- */

interface RoomState {
  readonly subscribers: Set<ActorRef<UsersChanged>>;
  ddUnsubscribe: (() => void) | null;
  /** Last fanned-out user list — reused for late `GetUsers` replies. */
  lastUsers: ReadonlyArray<string>;
}

/* ------------------------------- actor --------------------------------- */

export class OnlineUsersActor extends Actor<OnlineUsersCommand> {
  private dd!: DistributedDataHandle;
  private replicaId!: string;
  private readonly rooms = new Map<RoomName, RoomState>();

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

  override onReceive(cmd: OnlineUsersCommand): void {
    match(cmd)
      .with({ kind: 'AddToRoom' }, (m) => this.add(m.room, m.username))
      .with({ kind: 'RemoveFromRoom' }, (m) => this.remove(m.room, m.username))
      .with({ kind: 'Subscribe' }, (m) => this.subscribe(m.room, m.ref))
      .with({ kind: 'Unsubscribe' }, (m) => this.unsubscribe(m.room, m.ref))
      .with({ kind: 'GetUsers' }, (m) => this.getUsers(m.room, m.replyTo))
      .exhaustive();
  }

  /* ----------------------------- mutations ----------------------------- */

  private add(room: RoomName, username: string): void {
    this.dd.update<ORSet<string>>(
      ddKey(room),
      () => ORSet.empty<string>(),
      (current) => current.add(this.replicaId, username),
    );
  }

  private remove(room: RoomName, username: string): void {
    this.dd.update<ORSet<string>>(
      ddKey(room),
      () => ORSet.empty<string>(),
      (current) => current.remove(username),
    );
  }

  /* ----------------------------- subscription -------------------------- */

  private subscribe(room: RoomName, ref: ActorRef<UsersChanged>): void {
    const state = this.ensureRoomState(room);
    state.subscribers.add(ref);
    // Replay the last-known value to the new subscriber so they don't
    // wait for the next change to populate their UI.
    if (state.lastUsers.length > 0 || state.ddUnsubscribe) {
      ref.tell({ kind: 'UsersChanged', room, users: state.lastUsers });
    }
  }

  private unsubscribe(room: RoomName, ref: ActorRef<UsersChanged>): void {
    const state = this.rooms.get(room);
    if (!state) return;
    state.subscribers.delete(ref);
    if (state.subscribers.size === 0) {
      // No locally interested sessions — drop the DD subscription too.
      state.ddUnsubscribe?.();
      this.rooms.delete(room);
    }
  }

  private getUsers(room: RoomName, replyTo: ActorRef<UsersChanged>): void {
    const current = this.dd.get<ORSet<string>>(ddKey(room));
    const users = current ? [...current.value()] : [];
    replyTo.tell({ kind: 'UsersChanged', room, users });
  }

  private ensureRoomState(room: RoomName): RoomState {
    const existing = this.rooms.get(room);
    if (existing) return existing;
    const state: RoomState = {
      subscribers: new Set(),
      ddUnsubscribe: null,
      lastUsers: [],
    };
    this.rooms.set(room, state);
    state.ddUnsubscribe = this.dd.subscribe<ORSet<string>>(ddKey(room), (next) => {
      const users = [...next.value()];
      state.lastUsers = users;
      const evt: UsersChanged = { kind: 'UsersChanged', room, users };
      for (const sub of state.subscribers) {
        try {
          sub.tell(evt);
        } catch (e) {
          this.log.warn(`OnlineUsersActor: subscriber for ${room} threw`, e);
        }
      }
    });
    return state;
  }
}
