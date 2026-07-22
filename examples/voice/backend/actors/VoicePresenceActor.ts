/**
 * Per-key presence tracker, backed by DistributedData ORSets.
 *
 * Generalisation of the chat sample's `OnlineUsersActor`: the voice
 * sample needs **two** flavours of presence — a single global set
 * `voice.online-users` (everyone currently logged-in, regardless of
 * room) AND per-room sets `voice.room-users.<name>` (who's
 * currently in a given voice room).  Same subscriber-fan-out logic
 * works for both, so we factor on a free-form `Topic` rather than
 * `room: RoomName` like the chat actor.
 *
 * **Subscribe semantics** mirror the chat actor: each session
 * subscribes once per topic it cares about, this actor lazily
 * attaches a single DD-level subscription per topic, and broadcasts
 * change events to all interested local sessions.  The first
 * subscriber gets the current value replayed immediately so the UI
 * doesn't wait for the next change to populate.
 *
 * Voice-specific note: there is **no sharded entity actor** in this
 * sample — rooms are pure DD-ORSet (membership) + PubSub-topic
 * (audio).  This actor + the mediator are the only Per-Node
 * cluster machinery.
 */
import { match } from 'ts-pattern';
import { Actor, type ActorRef } from '../../../../src/index.js';
import { DistributedDataId } from '../../../../src/crdt/index.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';
import { ORSet } from '../../../../src/crdt/ORSet.js';

/* ------------------------ topic-key conventions ------------------------ */

export const ONLINE_USERS_KEY = 'voice.online-users';
export function roomUsersKey(room: string): string {
  return `voice.room-users.${room}`;
}

/* ----------------------------- public messages ------------------------- */

type AddCommand = {
  readonly kind: 'Add';
  readonly key: string;
  readonly username: string;
};
type RemoveCommand = {
  readonly kind: 'Remove';
  readonly key: string;
  readonly username: string;
};
type SubscribeCommand = {
  readonly kind: 'Subscribe';
  readonly key: string;
  readonly ref: ActorRef<PresenceChanged>;
};
type UnsubscribeCommand = {
  readonly kind: 'Unsubscribe';
  readonly key: string;
  readonly ref: ActorRef<PresenceChanged>;
};
type GetUsersCommand = {
  readonly kind: 'GetUsers';
  readonly key: string;
  readonly replyTo: ActorRef<PresenceChanged>;
};

export type VoicePresenceCommand =
  | AddCommand
  | RemoveCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | GetUsersCommand;

export type PresenceChanged = {
  readonly kind: 'PresenceChanged';
  readonly key: string;
  readonly users: ReadonlyArray<string>;
};

/* ------------------------------- internals ----------------------------- */

interface KeyState {
  readonly subscribers: Set<ActorRef<PresenceChanged>>;
  ddUnsubscribe: (() => void) | null;
  /** Last fanned-out user list — reused for late `GetUsers` replies. */
  lastUsers: ReadonlyArray<string>;
}

/* --------------------------------- actor ------------------------------- */

export class VoicePresenceActor extends Actor<VoicePresenceCommand> {
  private dd!: DistributedDataHandle;
  private replicaId!: string;
  private readonly states = new Map<string, KeyState>();

  override preStart(): void {
    this.dd = this.system.extension(DistributedDataId).get();
    this.replicaId = this.dd.selfReplicaId();
  }

  override postStop(): void {
    for (const state of this.states.values()) {
      state.ddUnsubscribe?.();
    }
    this.states.clear();
  }

  override onReceive(command: VoicePresenceCommand): void {
    match(command)
      .with({ kind: 'Add' },         (m) => this.onAdd(m))
      .with({ kind: 'Remove' },      (m) => this.onRemove(m))
      .with({ kind: 'Subscribe' },   (m) => this.onSubscribe(m))
      .with({ kind: 'Unsubscribe' }, (m) => this.onUnsubscribe(m))
      .with({ kind: 'GetUsers' },    (m) => this.onGetUsers(m))
      .exhaustive();
  }

  /* ----------------------------- mutations ----------------------------- */

  private onAdd(m: AddCommand): void {
    const { key, username } = m;
    this.dd.update<ORSet<string>>(
      key,
      () => ORSet.empty<string>(),
      (current) => current.add(this.replicaId, username),
    );
  }

  private onRemove(m: RemoveCommand): void {
    const { key, username } = m;
    this.dd.update<ORSet<string>>(
      key,
      () => ORSet.empty<string>(),
      (current) => current.remove(username),
    );
  }

  /* ----------------------------- subscription -------------------------- */

  private onSubscribe(m: SubscribeCommand): void {
    const { key, ref } = m;
    const state = this.ensureState(key);
    state.subscribers.add(ref);
    if (state.lastUsers.length > 0 || state.ddUnsubscribe) {
      ref.tell({ kind: 'PresenceChanged', key, users: state.lastUsers });
    }
  }

  private onUnsubscribe(m: UnsubscribeCommand): void {
    const { key, ref } = m;
    const state = this.states.get(key);
    if (!state) return;
    state.subscribers.delete(ref);
    if (state.subscribers.size === 0) {
      state.ddUnsubscribe?.();
      this.states.delete(key);
    }
  }

  private onGetUsers(m: GetUsersCommand): void {
    const { key, replyTo } = m;
    const current = this.dd.get<ORSet<string>>(key);
    const users = current ? [...current.value()] : [];
    replyTo.tell({ kind: 'PresenceChanged', key, users });
  }

  private ensureState(key: string): KeyState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const state: KeyState = {
      subscribers: new Set(),
      ddUnsubscribe: null,
      lastUsers: [],
    };
    this.states.set(key, state);
    state.ddUnsubscribe = this.dd.subscribe<ORSet<string>>(key, (next) => {
      const users = [...next.value()];
      state.lastUsers = users;
      const evt: PresenceChanged = { kind: 'PresenceChanged', key, users };
      for (const sub of state.subscribers) {
        try {
          sub.tell(evt);
        } catch (e) {
          this.log.warn(`VoicePresenceActor: subscriber for ${key} threw`, e);
        }
      }
    });
    return state;
  }
}
