import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import { SystemActorNames, SystemGroups } from '../internal/SystemPaths.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cancellable } from '../Scheduler.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../util/Constants.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import { randomId } from '../util/RandomString.js';
import {
  DEFAULT_MAX_GOSSIP_BYTES,
  DEFAULT_MAX_PENDING_QUORUM_REQUESTS,
  DEFAULT_MAX_QUORUM_TIMEOUT_MS,
  DistributedDataOptionsValidator,
  readDistributedDataOptionsFromConfig,
} from './DistributedDataOptions.js';
import type { DistributedDataOptions, DistributedDataOptionsType } from './DistributedDataOptions.js';
import type { Cluster } from '../cluster/Cluster.js';
import { MemberRemoved, MemberUp } from '../cluster/ClusterEvents.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import type { Crdt, CrdtIdentityFunction } from './Crdt.js';
import { DurableDistributedDataStore } from './DurableDistributedDataStore.js';
import { GOSSIP_SKIP_WARN_INTERVAL_MS, MAX_CRDT_NESTING_DEPTH } from './Constants.js';
import { encodeJsonTree } from '../serialization/JsonTree.js';
import { CrdtDecodeError } from './CrdtWireValidation.js';
import { GCounter, type GCounterJson } from './GCounter.js';
import { GCounterMap, type GCounterMapJson } from './GCounterMap.js';
import { PNCounter, type PNCounterJson } from './PNCounter.js';
import { GSet, type GSetJson } from './GSet.js';
import { ORSet, type ORSetJson } from './ORSet.js';
import { ORMap, type ORMapJson } from './ORMap.js';
import { LWWRegister, type LWWRegisterJson } from './LWWRegister.js';
import { LWWMap, type LWWMapJson } from './LWWMap.js';
import { MVRegister, type MVRegisterJson } from './MVRegister.js';

/* =========================== JSON discriminator ======================== */

/** Discriminated union of every CRDT's wire representation. */
export type CrdtJson =
  | GCounterJson
  | PNCounterJson
  | GSetJson
  | ORSetJson
  | LWWRegisterJson<unknown>
  | GCounterMapJson
  | LWWMapJson<unknown>
  | MVRegisterJson<unknown>
  | ORMapJson;

/**
 * Reconstruct a CRDT from its `toJSON()` payload.  Dispatches on the
 * `kind` discriminator each impl writes — adding a new CRDT type is
 * one more case here.  Returned as `Crdt<unknown>` because the
 * concrete type is only known at the call site that asked for the
 * key in the first place.
 *
 * Exported so containers like `ORMap` (whose values are themselves
 * CRDTs of arbitrary kind) can wire it as their inner-value decoder.
 *
 * ## Reference example: discriminated-union dispatch
 *
 * This function is the **codebase's reference shape** for
 * dispatching on a closed string-literal-discriminator union.  Two
 * properties matter:
 *
 *   1. **No `default` arm** — the switch lists every kind explicitly.
 *      The `default` branch's `const _exhaustive: never = json`
 *      assertion gives compile-time exhaustiveness: TypeScript
 *      narrows `json` to `never` after all real arms; adding a new
 *      variant to `CrdtJson` without a matching `case` makes
 *      `json` *not* assignable to `never` and the file fails to
 *      compile.
 *
 *   2. **`throw` inside the default** — defensive belt-and-braces
 *      for the type-erasure boundary (legacy wire data, force-casts).
 *      Unreachable from well-typed callers.
 *
 * Equivalent shape: `match(json).with({ kind: 'X' }, ...).exhaustive()`
 * from `ts-pattern`.  Used elsewhere in the codebase when the
 * discriminator is more complex than a string literal (e.g. nominal
 * type via `instanceof`).  Both forms achieve compile-time
 * exhaustiveness; pick the more readable one per site.
 *
 * **Do not** add a permissive `default` case that returns a stub —
 * it defeats the exhaustiveness check and turns missing variants
 * into silent runtime bugs.
 *
 * The switch itself lives in {@link decodeCrdtAtDepth}, which carries the
 * nesting depth `ORMap` recursion has to bound; this is the entry point that
 * starts it at zero.
 *
 * ## The `identity` parameter
 *
 * A CRDT's identity function is a closure and cannot travel on the wire, so a
 * decoder has to be told which one to file elements under.  Passing none
 * leaves every set- and map-shaped value on the built-in `JSON.stringify`
 * dedup, which is what made the documented `identity` option inert for
 * anything DistributedData materialised from a frame or from its durable
 * record (#766).  The four kinds that have no element identity — the two
 * counters and the two registers — ignore it.
 *
 * Only the *outer* value is covered: an `ORMap`'s inner CRDTs decode through
 * this same dispatcher with no identity, because nothing in the frame or in
 * the caller's empty template says what theirs should be.
 */
export function decodeCrdt(json: CrdtJson, identity?: CrdtIdentityFunction): Crdt<any> {
  return decodeCrdtAtDepth(json, 0, identity);
}

function decodeCrdtAtDepth(
  json: CrdtJson, depth: number, identity: CrdtIdentityFunction | undefined,
): Crdt<any> {
  if (depth > MAX_CRDT_NESTING_DEPTH) {
    throw new CrdtDecodeError(`CRDT nesting deeper than ${MAX_CRDT_NESTING_DEPTH} levels`);
  }
  if (typeof json !== 'object' || json === null) {
    throw new CrdtDecodeError('CRDT payload must be an object');
  }
  switch (json.kind) {
    case 'GCounter':    return GCounter.fromJSON(json);
    case 'PNCounter':   return PNCounter.fromJSON(json);
    case 'GSet':        return GSet.fromJSON<unknown>(json, { identity });
    case 'ORSet':       return ORSet.fromJSON<unknown>(json, { identity });
    case 'LWWRegister': return LWWRegister.fromJSON<unknown>(json);
    case 'GCounterMap': return GCounterMap.fromJSON<unknown>(json, { identity });
    case 'LWWMap':      return LWWMap.fromJSON<unknown, unknown>(json, { identity });
    case 'MVRegister':  return MVRegister.fromJSON<unknown>(json);
    case 'ORMap':       return ORMap.fromJSON<unknown, Crdt<any>>(
      json,
      // Inner CRDTs decode through the same dispatcher — a value can
      // be any of the registered CRDT kinds.  Identity stops at this level;
      // see the entry point's doc.
      (inner) => decodeCrdtAtDepth(inner as CrdtJson, depth + 1, undefined) as Crdt<any>,
      { identity },
    );
    default: {
      const _exhaustive: never = json;
      void _exhaustive;
      throw new Error(`decodeCrdt: unknown CRDT kind`);
    }
  }
}

/**
 * `identity`, answering with the built-in `JSON.stringify` key for an element
 * it refuses rather than throwing.
 *
 * Exactly one caller — {@link DistributedDataActor.repairKeying}, and
 * deliberately not any wire decode.  Its doc carries the reasoning; the short
 * version is that the value being repaired is one this replica already holds,
 * so a refused element has to keep a key rather than cost the key its identity,
 * whereas a frame that arrives *after* the identity is known is refused by
 * `decodeOrDrop` and loses nothing.
 *
 * `JSON.stringify` is spelled out here rather than imported because every CRDT
 * module declares its own module-local `defaultIdentity` on purpose — see
 * `Crdt.customIdentity`, which identity-compares against it.
 */
function withDefaultKeyForRefusedElements(identity: CrdtIdentityFunction): CrdtIdentityFunction {
  return (value) => {
    try {
      return identity(value);
    } catch {
      return JSON.stringify(value);
    }
  };
}

/**
 * Empty-CRDT factory.  Callers pass this to `update(key, factory, mutator)`
 * so the extension can materialize a brand-new CRDT for a key that
 * doesn't exist yet — without DistributedData itself needing to know
 * about every CRDT type.
 *
 *   GCounter.empty       satisfies CrdtFactory<GCounter>
 *   () => ORSet.empty()  satisfies CrdtFactory<ORSet<X>>
 */
export type CrdtFactory<C extends Crdt<C>> = () => C;

/* ============================== gossip wire ============================ */

/**
 * One gossip round = a snapshot of every key this replica currently
 * knows.  Receivers merge each entry into their own state.
 *
 * Deliberately simple: no digest, no delta — just push the full set
 * to one random peer per tick.  Cheap to implement and good enough
 * for the small-to-medium stores DistributedData is meant for.
 */
type DDataGossipMessage = {
  readonly kind: 'ddata-gossip';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  /** Keyed by user-key; payload is the CRDT's own JSON discriminator. */
  readonly entries: Record<string, CrdtJson>;
};

/* ====================== quorum write / read wire ======================= */

/**
 * Quorum-write request — sent by the originator of a
 * `updateAsync(..., { consistency: 'majority' | 'all' | { from } })`
 * call to every other up-member.  Each receiver merges `value` into
 * its local replica (same merge as gossip) and replies with a
 * `DDataWriteAcknowledgmentMessage` carrying the same `pendingId` so the originator
 * can match it to the pending write.
 */
type DDataWriteRequestMessage = {
  readonly kind: 'ddata-write-request';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
  readonly value: CrdtJson;
};

type DDataWriteAcknowledgmentMessage = {
  readonly kind: 'ddata-write-ack';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
};

/**
 * Quorum-read request — sent by the originator of a
 * `getAsync(..., { consistency: ... })` call to every other
 * up-member.  Each receiver replies with its current local value
 * (or `null` if it has no entry) so the originator can merge the
 * responses and return the result.
 */
type DDataReadRequestMessage = {
  readonly kind: 'ddata-read-request';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
};

type DDataReadResponseMessage = {
  readonly kind: 'ddata-read-response';
  readonly from: ReturnType<NodeAddress['toJSON']>;
  readonly pendingId: string;
  readonly key: string;
  readonly value: CrdtJson | null;
};

/* ============================== consistency =========================== */

/**
 * Quorum target for `updateAsync` / `getAsync`.
 *
 *   - `'local'` — return immediately after applying locally.  Equivalent
 *     to the sync `update` / `get` API, kept for API symmetry.
 *   - `'majority'` — wait for `floor(N/2)+1` replicas (incl. self).
 *   - `'all'` — wait for every up-member.
 *   - `{ from: K }` — wait for `K` replicas (clamped to `[1, N]`).
 *
 * `N` is `cluster.upMembers().length` at the moment the call starts.
 * Self always counts as the first ack (the local apply is synchronous),
 * so a single-node cluster resolves immediately regardless of the
 * chosen consistency level.
 */
export type WriteConsistency =
  | 'local'
  | 'majority'
  | 'all'
  | { readonly from: number };

export type ReadConsistency = WriteConsistency;

/* ============================== extension ============================== */

/**
 * Cluster-wide replicated key-value store of CRDTs.  Each node hosts
 * one local replica.  `update(key, ...)` mutates the local replica
 * (idempotent, conflict-free), and gossip fans the state out so
 * every replica eventually agrees on `merge(...)` of all updates.
 *
 * **Lifecycle:** call `extension(DistributedDataId).start(cluster)`
 * once per process to spawn the internal gossip actor.  Subsequent
 * calls return the same handle.
 *
 *   const dd = system.extension(DistributedDataId).start(cluster);
 *   dd.update('cart-42', () => ORSet.empty<string>(),
 *     (cart) => cart.add(cluster.selfAddress.toString(), 'apple'));
 *   const cart = dd.get<ORSet<string>>('cart-42');
 *
 * **Limits / non-goals (v1):**
 *   - Full-state push on every gossip tick, sliced to fit one frame.
 *     There is no delta tracking and no per-peer receipt history, so
 *     gossip volume follows total state rather than update rate; a
 *     store larger than `maxGossipBytes` is pushed a slice at a time
 *     and converges over several ticks instead of one (#691).  Delta
 *     replication is #444.
 *   - A single key whose own encoding exceeds that budget cannot be
 *     sliced any further — it is skipped and warned about, and it does
 *     not converge.  See `DistributedDataOptionsType.maxGossipBytes`.
 *   - Durability is opt-in: without `durableStore` the replica lives
 *     in memory and a full cluster restart starts every node empty.
 *   - No tombstone delete; `delete(key)` is best-effort and can be
 *     undone by an in-flight gossip from a peer who still has the
 *     key.  Plan a workload-specific tombstone pattern (typically
 *     embed deletion in the CRDT — e.g. `ORSet.remove`).
 */
export class DistributedData implements Extension {
  private _handle: DistributedDataHandle | null = null;
  private _cluster: Cluster | null = null;

  constructor(private readonly system: ActorSystem) {}

  start(
    cluster: Cluster,
    options: DistributedDataOptions = {},
  ): DistributedDataHandle {
    if (this._handle && this._cluster === cluster) return this._handle;
    if (this._handle) {
      throw new Error('DistributedData is already bound to a different cluster');
    }
    this._cluster = cluster;
    // The documented precedence: explicit options beat
    // `actor-ts.distributed-data.*`, which beats the actor's built-ins.
    // Validation runs once here, on the merged settings, so a bad value is
    // caught whether it came from the builder, a plain object or HOCON.
    const resolvedOptions = mergeOptions<DistributedDataOptionsType>(
      {},
      readDistributedDataOptionsFromConfig(this.system.config),
      options as Partial<DistributedDataOptionsType>,
    );
    new DistributedDataOptionsValidator().validate(resolvedOptions);

    // The extension exposes a synchronous API; the internal actor owns
    // the state and the gossip loop.  We hand the actor a setter for a
    // shared "view" the public handle reads, so callers don't have to
    // ask().
    const view: SharedView = { state: new Map(), listeners: new Map() };
    const ref = this.system._spawnSystemActor(
      () => new DistributedDataActor({ cluster, options: resolvedOptions, view }),
      SystemGroups.clusterCrdt,
      SystemActorNames.distributedData,
    );
    // Register wire handlers SYNCHRONOUSLY here — `spawn` returns
    // before the actor's async `preStart` has run, but quorum
    // writes/reads need every peer to already be routing inbound
    // requests by the time the originator sends them.  Forwarding via
    // `ref.tell(...)` instead of `self.tell(...)` is safe: messages
    // queued before preStart completes wait in the mailbox.
    const unsubscribes: Array<() => void> = [];
    for (const kind of [
      'ddata-gossip',
      'ddata-write-request',
      'ddata-write-ack',
      'ddata-read-request',
      'ddata-read-response',
    ] as const) {
      unsubscribes.push(cluster._onWire(kind, (message, from) => {
        ref.tell({ kind: 'ddata-wire', peer: from, frame: message as unknown as DDataWireFrame });
      }));
    }
    this._handle = new DistributedDataHandle(ref, view, cluster, unsubscribes);
    return this._handle;
  }

  /** Tear down the wire-handler subscriptions (test/shutdown only). */
  stop(): void {
    if (this._handle) {
      this._handle._stopWireHandlers();
    }
  }

  get(): DistributedDataHandle {
    if (!this._handle) {
      throw new Error('DistributedData.start(cluster) must be called first');
    }
    return this._handle;
  }

  isStarted(): boolean { return this._handle !== null; }
}

export const DistributedDataId: ExtensionId<DistributedData> = extensionId<DistributedData>(
  'actor-ts/crdt/distributed-data',
  (system) => new DistributedData(system),
);

/* ============================== handle ============================== */

/** Shared between actor + handle so reads stay synchronous. */
type SharedView = {
  state: Map<string, Crdt<any>>;
  listeners: Map<string, Set<(value: Crdt<any>) => void>>;
};

type UpdateMessage = {
  readonly kind: 'ddata-update';
  readonly key: string;
  readonly factory: CrdtFactory<Crdt<any>>;
  readonly mutator: (c: Crdt<any>) => Crdt<any>;
  /**
   * Optional quorum options.  When present, the update runs as a
   * quorum write — the actor broadcasts the merged value to peers,
   * collects acks, and only then resolves the user's promise.  When
   * absent, behaves like the legacy sync path (apply locally + let
   * gossip carry the value eventually).
   */
  readonly quorum?: {
    readonly pendingId: string;
    readonly consistency: WriteConsistency;
    readonly timeoutMs: number;
    readonly resolve: () => void;
    readonly reject: (err: Error) => void;
  };
};
type DeleteMessage = { readonly kind: 'ddata-delete'; readonly key: string };
/** Out-of-mailbox: a quorum-read user call.  See {@link DistributedDataHandle.getAsync}. */
type ReadMessage = {
  readonly kind: 'ddata-read';
  readonly key: string;
  readonly pendingId: string;
  readonly consistency: ReadConsistency;
  readonly timeoutMs: number;
  readonly resolve: (value: Crdt<any> | undefined) => void;
  readonly reject: (err: Error) => void;
};
/** Every frame DistributedData registers a wire handler for. */
type DDataWireFrame =
  | DDataGossipMessage
  | DDataWriteRequestMessage
  | DDataWriteAcknowledgmentMessage
  | DDataReadRequestMessage
  | DDataReadResponseMessage;

/**
 * A wire frame together with the peer whose connection it arrived on.
 *
 * The wrapper exists because the authenticated identity has to survive the
 * trip through the actor's mailbox.  `Cluster._onWire` hands the handler
 * that peer, but the handler forwards with `ref.tell(...)` — so registering
 * a one-parameter arrow, as this extension did, drops the only trustworthy
 * thing about the frame and leaves the actor with the sender's self-declared
 * `from` (#719, #723).
 */
type WireFrameMessage = {
  readonly kind: 'ddata-wire';
  /** Connection-authenticated sender.  Not `frame.from`, which the sender writes. */
  readonly peer: NodeAddress;
  readonly frame: DDataWireFrame;
};

type ActorMessage =
  | UpdateMessage
  | DeleteMessage
  | ReadMessage
  | WireFrameMessage;

/**
 * Public handle returned from `extension.start(cluster)`.  Holds a
 * ref to the internal actor + a synchronously-readable view of the
 * replicated state.
 */
export class DistributedDataHandle {
  constructor(
    private readonly ref: ActorRef<ActorMessage>,
    private readonly view: SharedView,
    private readonly cluster: Cluster,
    private wireUnsubscribes: ReadonlyArray<() => void> = [],
  ) {}

  /** @internal — called by the extension's `stop()`. */
  _stopWireHandlers(): void {
    for (const unsubscribe of this.wireUnsubscribes) unsubscribe();
    this.wireUnsubscribes = [];
  }

  /** Synchronously read the local replica's view of `key`. */
  get<C extends Crdt<C>>(key: string): C | undefined {
    return this.view.state.get(key) as C | undefined;
  }

  /**
   * Mutate `key` via `mutator`.  If the key doesn't exist yet, `factory()`
   * is called to seed a fresh CRDT.  The mutation runs on the actor
   * thread so concurrent local callers serialize cleanly.
   */
  update<C extends Crdt<C>>(
    key: string, factory: CrdtFactory<C>, mutator: (current: C) => C,
  ): void {
    this.ref.tell({
      kind: 'ddata-update', key,
      factory: factory as unknown as CrdtFactory<Crdt<any>>,
      mutator: mutator as unknown as (c: Crdt<any>) => Crdt<any>,
    });
  }

  /**
   * Quorum-write variant of {@link update}.  Returns a promise that
   * resolves only after the requested number of replicas have
   * acknowledged the merge.  Self always counts as the first ack, so
   * single-node clusters and `consistency: 'local'` resolve as soon as
   * the local apply is done.
   *
   * Rejects with a timeout error if not enough acks arrive within
   * `timeoutMs` (default `gossipIntervalMs × 5`).  A timeout does NOT
   * roll the local write back — the value is already applied locally
   * and will continue to gossip; the rejection only signals "I'm not
   * sure enough replicas saw it".
   *
   * Two settings bound the wait: `timeoutMs` is clamped to
   * `maxQuorumTimeout`, and the call rejects immediately — again without
   * undoing the local write — when `maxPendingQuorumRequests` unsettled
   * quorum requests are already in flight.
   *
   *   await dd.updateAsync<GCounter>('hits', GCounter.empty,
   *     (c) => c.increment(dd.selfReplicaId(), 1),
   *     { consistency: 'majority' });
   */
  updateAsync<C extends Crdt<C>>(
    key: string,
    factory: CrdtFactory<C>,
    mutator: (current: C) => C,
    options: { readonly consistency: WriteConsistency; readonly timeoutMs?: number } = {
      consistency: 'local',
    },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pendingId = nextPendingId();
      const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      this.ref.tell({
        kind: 'ddata-update', key,
        factory: factory as unknown as CrdtFactory<Crdt<any>>,
        mutator: mutator as unknown as (c: Crdt<any>) => Crdt<any>,
        quorum: {
          pendingId, consistency: options.consistency, timeoutMs,
          resolve, reject,
        },
      });
    });
  }

  /**
   * Quorum-read variant of {@link get}.  Sends a read request to peers
   * matching the consistency target, merges all incoming responses
   * (plus the local replica), and resolves with the merged value.
   * `undefined` if no replica knows the key.
   *
   * Self always counts as the first response — `'local'` returns
   * immediately with whatever's in the local view.  Timeout default,
   * `maxQuorumTimeout` clamping and the `maxPendingQuorumRequests`
   * rejection are all the same as {@link updateAsync}; unlike a write,
   * a read that *does* get tracked resolves best-effort on timeout with
   * whatever merged so far.
   *
   *   const cart = await dd.getAsync<ORSet<string>>('cart-42',
   *     { consistency: 'majority' });
   */
  getAsync<C extends Crdt<C>>(
    key: string,
    options: { readonly consistency: ReadConsistency; readonly timeoutMs?: number } = {
      consistency: 'local',
    },
  ): Promise<C | undefined> {
    return new Promise<C | undefined>((resolve, reject) => {
      const pendingId = nextPendingId();
      const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      this.ref.tell({
        kind: 'ddata-read', key, pendingId,
        consistency: options.consistency, timeoutMs,
        resolve: resolve as (v: Crdt<any> | undefined) => void,
        reject,
      });
    });
  }

  /**
   * Best-effort delete.  Forgets `key` on this replica only — peers
   * may re-introduce it via gossip.  See class header for the
   * tombstone story.
   */
  delete(key: string): void {
    this.ref.tell({ kind: 'ddata-delete', key });
  }

  /**
   * Subscribe to changes for `key`.  Listener fires synchronously
   * after every successful update / merge that changes the local
   * value (deep-equal check via the CRDT's own `toJSON`).  Returns
   * an unsubscribe function.
   */
  subscribe<C extends Crdt<C>>(
    key: string, listener: (value: C) => void,
  ): () => void {
    let set = this.view.listeners.get(key);
    if (!set) { set = new Set(); this.view.listeners.set(key, set); }
    const wrapper = listener as unknown as (value: Crdt<any>) => void;
    set.add(wrapper);
    // Replay current value so a late subscriber catches up immediately.
    const current = this.view.state.get(key);
    if (current) {
      try { wrapper(current); } catch (e) { /* ignore in tests */ void e; }
    }
    return () => {
      const listenerSet = this.view.listeners.get(key);
      if (listenerSet) {
        listenerSet.delete(wrapper);
        if (listenerSet.size === 0) this.view.listeners.delete(key);
      }
    };
  }

  /** Snapshot of every key currently known on the local replica. */
  keys(): string[] {
    return Array.from(this.view.state.keys());
  }

  /** ReplicaId used when seeding ops (delegated from `cluster.selfAddress`). */
  selfReplicaId(): string {
    return this.cluster.selfAddress.toString();
  }
}

/* ============================== internal actor ======================== */

/**
 * Pending quorum-write — produced by `updateAsync` and tracked until
 * either enough peer acks arrive or the timeout fires.  `acks` is a
 * set of `address.toString()` so duplicates from a flaky peer count
 * once; self always counts as the first ack.
 */
type PendingWrite = {
  readonly kind: 'write';
  readonly key: string;
  readonly required: number;
  /**
   * Peers this request actually went to.  A reply used to be matched on its
   * correlation id alone, so any member could answer a quorum it was never
   * part of (#768).
   */
  readonly targets: ReadonlySet<string>;
  readonly acks: Set<string>;
  readonly timer: Cancellable;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
};

/**
 * Pending quorum-read — produced by `getAsync`.  Collects local +
 * peer values and merges them when either the quorum count is met or
 * the timeout fires.  `merged` accumulates as responses arrive so the
 * timeout path can still resolve with a partial answer (best-effort)
 * — we treat reads as "best-available" rather than strict.
 */
type PendingRead = {
  /** Peers this request actually went to — see {@link PendingWrite.targets}. */
  readonly targets: ReadonlySet<string>;
  readonly kind: 'read';
  readonly key: string;
  readonly required: number;
  readonly responses: Set<string>;
  readonly timer: Cancellable;
  merged: Crdt<any> | undefined;
  readonly resolve: (value: Crdt<any> | undefined) => void;
  readonly reject: (err: Error) => void;
};

/** Which of the two quorum flavours a metric series belongs to. */
type QuorumOperation = 'write' | 'read';

/** Why a local key could not travel in the frame being packed. */
type GossipSkipReason = 'oversize' | 'unserialisable';

/**
 * One entry's wire form together with what it costs the frame — paired so the
 * packer never serialises the same CRDT twice, once to measure and once to
 * send.
 */
type MeasuredGossipEntry = {
  readonly json: CrdtJson;
  readonly bytes: number;
};

/**
 * What one tick had to leave behind, accumulated for the rate-limited warning.
 *
 * Mutable and tick-local: the warning wants totals and the single worst
 * offender, not a line per key, so the packing loop folds into this and the
 * reporter reads it once.
 */
type GossipSkipTally = {
  oversize: number;
  unserialisable: number;
  largest: { readonly key: string; readonly bytes: number } | null;
};

/**
 * Shared encoder for the gossip byte accounting.  One instance rather than one
 * per measurement: the packer measures every key on every tick, and a fresh
 * `TextEncoder` per entry would allocate more than the strings it is sizing.
 */
const utf8 = new TextEncoder();

class DistributedDataActor extends Actor<ActorMessage> {
  private readonly view: SharedView;
  private readonly gossipIntervalMs: number;
  /** `0` disables the cap.  See the options field for the mailbox argument. */
  private readonly maxPendingQuorumRequests: number;
  /** `0` disables the ceiling. */
  private readonly maxQuorumTimeoutMs: number;
  private readonly durable: DurableDistributedDataStore | null;
  private gossipTimer: Cancellable | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  /** Set while a durable save is in flight; subsequent changes set
   *  `_durableDirty = true` so the in-flight save is followed by a
   *  catch-up save instead of multiple overlapping saves. */
  private durableSaveInFlight = false;
  private durableDirty = false;
  /** Outstanding quorum-write requests, keyed by pendingId. */
  private readonly pendingWrites = new Map<string, PendingWrite>();
  /** Outstanding quorum-read requests, keyed by pendingId. */
  private readonly pendingReads = new Map<string, PendingRead>();
  /**
   * Peer-supplied values this replica refused to decode.  Kept as a plain
   * field *in addition to* `distributed_data_dropped_values_total` because it
   * is what the warn line carries: a running total in the log lets an
   * operator tell one garbled frame from a peer producing them steadily,
   * without a metrics backend being wired up at all.
   */
  private droppedFrames = 0;
  /**
   * Per-key element identity, learned from the `factory` that `update`
   * already carries — `null` once a key is known to be on the default.
   *
   * This is what makes the documented `identity` option work for a value
   * DistributedData materialised rather than the application constructing it
   * (#766).  Deriving it beats a `register(key, factory)` on the handle for a
   * reason that is not about taste: `DistributedDataHandle` is re-exported by
   * no entry point (#1307), so a method added there would land on a type
   * consumers cannot name — while `update`'s factory is already in every
   * caller's hands and already says exactly this.
   *
   * Growth is one small entry per *live* key, the same shape the view has:
   * {@link onDelete} drops the entry with the value, and the next `update`
   * for a resurrected key relearns it and re-keys whatever gossip brought
   * back in the meantime.
   */
  private readonly identities = new Map<string, CrdtIdentityFunction | null>();
  /** `0` removes the budget.  Still clamped to the transport's frame cap. */
  private readonly maxGossipBytes: number;
  /**
   * Where the next gossip tick resumes in the key list — an index, not a key.
   *
   * A store too large for one frame is swept in slices, and the cursor is what
   * makes the sweep cover the whole key set: it advances by exactly as many
   * positions as the tick consumed and wraps at the end.  Keys are visited in
   * `Map` insertion order, so a concurrent insert or delete shifts the window
   * by one slot and a key can be missed on one sweep; it is picked up on the
   * next, because the cursor always advances and always wraps.  That is enough
   * for a state-based CRDT, where a missed round costs latency and a repeated
   * one costs nothing (merge is idempotent).
   */
  private gossipCursor = 0;
  /**
   * Keys skipped because their own encoding exceeds the gossip budget, and
   * when that was last said out loud.
   *
   * Both fields exist for the log line rather than for the logic: the
   * condition recurs on every tick for as long as the key does, so the
   * warning is rate-limited to {@link GOSSIP_SKIP_WARN_INTERVAL_MS} and
   * carries the running total, which is what tells one fat key from a
   * workload steadily producing them.  The per-occurrence series lives in
   * `distributed_data_gossip_skipped_keys_total`.
   */
  private gossipSkips = 0;
  private lastGossipSkipWarnAtMs = 0;

  constructor(public readonly options: {
    cluster: Cluster;
    options: DistributedDataOptionsType;
    view: SharedView;
  }) {
    super();
    this.view = options.view;
    this.gossipIntervalMs = options.options.gossipInterval ?? 1_000;
    this.maxPendingQuorumRequests =
      options.options.maxPendingQuorumRequests ?? DEFAULT_MAX_PENDING_QUORUM_REQUESTS;
    this.maxQuorumTimeoutMs = options.options.maxQuorumTimeout ?? DEFAULT_MAX_QUORUM_TIMEOUT_MS;
    this.maxGossipBytes = options.options.maxGossipBytes ?? DEFAULT_MAX_GOSSIP_BYTES;
    this.durable = options.options.durableStore
      ? new DurableDistributedDataStore(
          options.options.durableStore,
          options.cluster.selfAddress.toString(),
        )
      : null;
  }

  /**
   * The cluster `DistributedData.start` was bound to, which is what this
   * actor must gossip over — not whatever `system.cluster` happens to
   * resolve to.  The two are the same in every normal setup; overriding
   * keeps them the same in the ones where they aren't (a test wiring two
   * clusters through one system).  Reading the parameter property rather
   * than a copy of it means there is still exactly one owner.
   */
  protected override get cluster(): Cluster { return this.options.cluster; }

  override async preStart(): Promise<void> {
    // Wire handlers are registered in the extension's `start()` so they're
    // ready BEFORE the user can issue the first quorum write — registering
    // them here would race with `updateAsync` called immediately after
    // `extension.start()` returns.
    this.unsubscribeCluster = this.cluster.subscribe((evt) =>
      match(evt)
        .with(P.instanceOf(MemberUp), () => this.onMemberUp())
        .with(P.instanceOf(MemberRemoved), () => this.onMemberRemoved())
        .otherwise(() => this.onOtherClusterEvent()),
    );
    this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.gossipIntervalMs, this.gossipIntervalMs, () => this.gossipTick(),
    );

    if (this.durable) {
      // Load + populate the in-memory view BEFORE accepting any
      // user-issued updates.  Subscribers registered after preStart
      // will see the recovered values via the handle's replay
      // mechanism (subscribe() fires once with the current value).
      try {
        const loaded = await this.durable.load((key) => this.identityFor(key));
        for (const [key, crdt] of loaded) {
          this.applyMerged(key, null, crdt);
        }
      } catch (err) {
        this.log.warn(`DistributedData: durable load failed`, err);
      }
    }
  }

  private onMemberUp(): void {
    /* trigger an early gossip */
    this.gossipTick();
  }

  private onMemberRemoved(): void {
    /* nothing local to clean */
  }

  private onOtherClusterEvent(): void {
    /* ignored */
  }

  override postStop(): void {
    this.unsubscribeCluster?.();
    this.gossipTimer?.cancel();
    // Reject any still-pending quorum requests so callers don't hang.
    for (const pendingWrite of this.pendingWrites.values()) {
      pendingWrite.timer.cancel();
      pendingWrite.reject(new Error(`DistributedData stopped before quorum write on "${pendingWrite.key}" completed`));
    }
    this.pendingWrites.clear();
    for (const pendingRead of this.pendingReads.values()) {
      pendingRead.timer.cancel();
      pendingRead.reject(new Error(`DistributedData stopped before quorum read on "${pendingRead.key}" completed`));
    }
    this.pendingReads.clear();
    this.syncPendingQuorumGauge();
  }

  /* ----------------------------- quorum caps ---------------------------- */

  /**
   * True when another pending quorum request would exceed the cap.
   *
   * Writes and reads share one budget rather than getting one each: what the
   * cap bounds is unsettled promises and armed timers, and the two flavours
   * cost the same.  Two half-sized budgets would only make the reachable
   * total harder to state.
   */
  private isPendingQuorumCapReached(): boolean {
    if (this.maxPendingQuorumRequests === 0) return false;
    return this.pendingQuorumCount() >= this.maxPendingQuorumRequests;
  }

  private pendingQuorumCount(): number {
    return this.pendingWrites.size + this.pendingReads.size;
  }

  /**
   * Clamp a caller's `timeoutMs` to the configured ceiling.  Clamping rather
   * than rejecting, for the same reason `clampQuorum` clamps `{ from: K }`:
   * the request is well-formed and runnable, only its deadline is out of
   * range, and a shorter deadline costs the caller a rejection they already
   * handle instead of one they don't.
   */
  private cappedQuorumTimeout(requestedMs: number): number {
    if (this.maxQuorumTimeoutMs === 0) return requestedMs;
    return Math.min(requestedMs, this.maxQuorumTimeoutMs);
  }

  /**
   * The error a request over the cap is rejected with.  It names the knob:
   * the entire point of the cap is that the failure is legible, since the
   * alternative it replaces — a `ddata-update` envelope dropped by the
   * mailbox's `drop-head` policy, taking `resolve`/`reject` with it — leaves
   * the caller awaiting a promise that can never settle (#140).
   */
  private quorumOverflowError(operation: QuorumOperation, key: string): Error {
    return new Error(
      `DistributedData refused a quorum ${operation} on "${key}": `
      + `${this.pendingQuorumCount()} quorum requests are already pending `
      + `(max-pending-quorum-requests = ${this.maxPendingQuorumRequests})`,
    );
  }

  /* ------------------------------- metrics ------------------------------ */

  /**
   * Publish the current pending-quorum depth.  Read fresh from the extension
   * on every call rather than cached, because `MetricsExtension.enable()` may
   * land after this actor started and a cached registry would pin the noop —
   * the same reason `Cluster` resolves it per call site.
   *
   * Label sets across this file are deliberately tiny: `operation` has two
   * values and the gauge has none, so DistributedData contributes a fixed
   * handful of series and cannot push a family into the registry's
   * cardinality cap (#131).
   */
  private syncPendingQuorumGauge(): void {
    metricsOf(this.system).gauge(
      'distributed_data_quorum_pending', {},
      { help: 'Quorum reads and writes currently awaiting peer replies on this replica.' },
    ).set(this.pendingQuorumCount());
  }

  private countQuorumTimeout(operation: QuorumOperation): void {
    metricsOf(this.system).counter(
      'distributed_data_quorum_timeouts_total', { operation },
      { help: 'Quorum requests that hit their deadline before enough replicas replied.' },
    ).inc();
  }

  private countQuorumRejected(operation: QuorumOperation): void {
    metricsOf(this.system).counter(
      'distributed_data_quorum_rejected_total', { operation },
      { help: 'Quorum requests refused because the pending-request cap was reached.' },
    ).inc();
  }

  private countDroppedFrame(): void {
    metricsOf(this.system).counter(
      'distributed_data_dropped_values_total', {},
      { help: 'Peer-supplied CRDT values this replica refused to decode.' },
    ).inc();
  }

  override onReceive(message: ActorMessage): void {
    match(message)
      .with({ kind: 'ddata-update' }, (m) => this.onUpdate(m))
      .with({ kind: 'ddata-delete' }, (m) => this.onDelete(m))
      .with({ kind: 'ddata-read' }, (m) => this.onRead(m))
      .with({ kind: 'ddata-wire' }, (m) => this.onWireFrame(m))
      .exhaustive();
  }

  /**
   * Inbound frame from a peer.  Every handler below takes the connection's
   * peer as a separate argument and must use it in preference to the
   * frame's own `from` — that field is the one an attacker fully controls.
   */
  private onWireFrame(envelope: WireFrameMessage): void {
    const { peer, frame } = envelope;
    match(frame)
      .with({ kind: 'ddata-gossip' }, (m) => this.onGossip(m, peer))
      .with({ kind: 'ddata-write-request' }, (m) => this.onWriteRequest(m, peer))
      .with({ kind: 'ddata-write-ack' }, (m) => this.onWriteAcknowledgment(m, peer))
      .with({ kind: 'ddata-read-request' }, (m) => this.onReadRequest(m, peer))
      .with({ kind: 'ddata-read-response' }, (m) => this.onReadResponse(m, peer))
      .exhaustive();
  }

  private onUpdate(message: UpdateMessage): void {
    // Before the read, not after: learning the identity can replace the
    // stored value with a re-keyed copy of itself.
    this.learnIdentity(message.key, message.factory);
    const current = this.view.state.get(message.key) ?? message.factory();
    const next = message.mutator(current);
    this.applyMerged(message.key, current, next);
    if (!message.quorum) return;

    // Quorum write: self-vote counts as the first ack.  If only self
    // is needed (single-node, or 'local'), resolve immediately;
    // otherwise broadcast a write-request to peers and arm a timer.
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    const totalN = 1 + peers.length;
    const required = clampQuorum(message.quorum.consistency, totalN);
    const acks = new Set<string>([this.cluster.selfAddress.toString()]);
    if (acks.size >= required) {
      message.quorum.resolve();
      return;
    }
    if (this.isPendingQuorumCapReached()) {
      message.quorum.reject(this.quorumOverflowError('write', message.key));
      this.countQuorumRejected('write');
      return;
    }
    const timeoutMs = this.cappedQuorumTimeout(message.quorum.timeoutMs);
    const timer = this.system.scheduler.scheduleOnceFunction(timeoutMs, () => {
      const pending = this.pendingWrites.get(message.quorum!.pendingId);
      if (!pending) return;
      this.pendingWrites.delete(message.quorum!.pendingId);
      this.syncPendingQuorumGauge();
      this.countQuorumTimeout('write');
      pending.reject(new Error(
        `DistributedData quorum write on "${message.key}" timed out after ${timeoutMs}ms ` +
        `(${pending.acks.size}/${pending.required} acks)`,
      ));
    });
    this.pendingWrites.set(message.quorum.pendingId, {
      kind: 'write', key: message.key, required, acks, timer,
      targets: new Set(peers.map((m) => m.address.toString())),
      resolve: message.quorum.resolve, reject: message.quorum.reject,
    });
    this.syncPendingQuorumGauge();
    const wire: DDataWriteRequestMessage = {
      kind: 'ddata-write-request',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.quorum.pendingId,
      key: message.key,
      value: next.toJSON() as CrdtJson,
    };
    for (const peer of peers) {
      this.cluster.transport.send(peer.address, wire as unknown as WireMessage);
    }
  }

  private onRead(message: ReadMessage): void {
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    const totalN = 1 + peers.length;
    const required = clampQuorum(message.consistency, totalN);
    const localValue = this.view.state.get(message.key);
    const responses = new Set<string>([this.cluster.selfAddress.toString()]);
    if (responses.size >= required) {
      message.resolve(localValue);
      return;
    }
    if (this.isPendingQuorumCapReached()) {
      // Rejected rather than best-effort-resolved: a read the replica never
      // issued has not been degraded by slow peers, it has not happened at
      // all, and answering it with the local value would report a quorum
      // read that no peer contributed to.
      message.reject(this.quorumOverflowError('read', message.key));
      this.countQuorumRejected('read');
      return;
    }
    const timeoutMs = this.cappedQuorumTimeout(message.timeoutMs);
    const timer = this.system.scheduler.scheduleOnceFunction(timeoutMs, () => {
      const pending = this.pendingReads.get(message.pendingId);
      if (!pending) return;
      this.pendingReads.delete(message.pendingId);
      this.syncPendingQuorumGauge();
      this.countQuorumTimeout('read');
      // Best-effort: resolve with whatever we've merged so far rather
      // than rejecting outright.  Reads are forgiving — a partial
      // answer is more useful than no answer for most workloads.  If
      // *nothing* came back (not even local), keep undefined.
      pending.resolve(pending.merged);
    });
    this.pendingReads.set(message.pendingId, {
      kind: 'read', key: message.key, required, responses, timer,
      targets: new Set(peers.map((m) => m.address.toString())),
      merged: localValue,
      resolve: message.resolve, reject: message.reject,
    });
    this.syncPendingQuorumGauge();
    const wire: DDataReadRequestMessage = {
      kind: 'ddata-read-request',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.pendingId,
      key: message.key,
    };
    for (const peer of peers) {
      this.cluster.transport.send(peer.address, wire as unknown as WireMessage);
    }
  }

  private onWriteRequest(message: DDataWriteRequestMessage, peer: NodeAddress): void {
    // Merge the incoming value into our local replica (same merge
    // semantics as gossip) and ack back.
    const incoming = this.decodeOrDrop(message.value, message.key, peer);
    if (incoming === null) return;
    const current = this.view.state.get(message.key);
    const merged = current ? current.merge(incoming) : incoming;
    this.applyMerged(message.key, current ?? null, merged);
    // The ack goes back down the connection the request arrived on.  It used
    // to go to whatever address the payload named, so a peer could make this
    // node dial a host of its choosing and queue a full CRDT snapshot in a
    // `Connection.pending` buffer that is never drained (#723).
    const ack: DDataWriteAcknowledgmentMessage = {
      kind: 'ddata-write-ack',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.pendingId,
      key: message.key,
    };
    this.cluster.transport.send(peer, ack as unknown as WireMessage);
  }

  private onWriteAcknowledgment(message: DDataWriteAcknowledgmentMessage, peer: NodeAddress): void {
    const pending = this.pendingWrites.get(message.pendingId);
    if (!pending) return; // late ack after timeout / already resolved
    // Counted per authenticated peer.  Keyed on the payload's `from`, one
    // member could forge a whole quorum by acking under other members'
    // names and have its own CRDT state accepted as agreed (#719).
    const senderAddr = peer.toString();
    // The correlation id alone is not enough: it says which request this
    // claims to answer, not that the answer is about the same key or that
    // this peer was ever asked (#768).
    if (message.key !== pending.key) return;
    if (!pending.targets.has(senderAddr)) return;
    if (pending.acks.has(senderAddr)) return; // dedupe
    pending.acks.add(senderAddr);
    if (pending.acks.size >= pending.required) {
      pending.timer.cancel();
      this.pendingWrites.delete(message.pendingId);
      this.syncPendingQuorumGauge();
      pending.resolve();
    }
  }

  private onReadRequest(message: DDataReadRequestMessage, peer: NodeAddress): void {
    const local = this.view.state.get(message.key);
    const response: DDataReadResponseMessage = {
      kind: 'ddata-read-response',
      from: this.cluster.selfAddress.toJSON(),
      pendingId: message.pendingId,
      key: message.key,
      value: local ? (local.toJSON() as CrdtJson) : null,
    };
    this.cluster.transport.send(peer, response as unknown as WireMessage);
  }

  private onReadResponse(message: DDataReadResponseMessage, peer: NodeAddress): void {
    const pending = this.pendingReads.get(message.pendingId);
    if (!pending) return;
    const senderAddr = peer.toString();
    if (message.key !== pending.key) return;
    if (!pending.targets.has(senderAddr)) return;
    if (pending.responses.has(senderAddr)) return; // dedupe
    pending.responses.add(senderAddr);
    if (message.value !== null) {
      const incoming = this.decodeOrDrop(message.value, message.key, peer);
      // A garbled response counts as an answer — the peer replied, it just
      // replied with something unusable.  Dropping the value rather than the
      // whole response keeps the quorum from stalling on one bad replica.
      if (incoming !== null) {
        pending.merged = pending.merged ? pending.merged.merge(incoming) : incoming;
      }
    }
    if (pending.responses.size >= pending.required) {
      pending.timer.cancel();
      this.pendingReads.delete(message.pendingId);
      this.syncPendingQuorumGauge();
      // Also apply the merged value locally so the next sync `get`
      // sees the freshest view — a quorum read effectively pulls the
      // latest state to this replica without waiting for gossip.
      if (pending.merged) {
        const current = this.view.state.get(pending.key);
        this.applyMerged(pending.key, current ?? null,
          current ? current.merge(pending.merged) : pending.merged);
      }
      pending.resolve(pending.merged);
    }
  }

  private onDelete(message: DeleteMessage): void {
    // The learned identity goes with the value, so the registry never
    // outgrows the view.  Nothing is lost by it: a peer that re-introduces
    // the key gossips it under whatever identity it holds, and the next
    // `update` relearns and re-keys — the same repair a durable reload gets.
    this.identities.delete(message.key);
    if (this.view.state.delete(message.key)) {
      // Notify subscribers with a best-effort signal — we synthesise
      // a fresh CRDT via the most-recently-seen factory.  Since we
      // don't track factories per key, listeners just get nothing
      // for now; they'll see the next merge bring the key back if
      // a peer gossips it.
      this.scheduleDurableSave();
    }
  }

  private onGossip(message: DDataGossipMessage, peer: NodeAddress): void {
    if (peer.equals(this.cluster.selfAddress)) return; // shouldn't happen but harmless
    for (const [key, json] of Object.entries(message.entries)) {
      // Per key, not per frame: one unusable entry must not cost the sender's
      // other entries, which are independent CRDTs that happen to travel
      // together.
      const incoming = this.decodeOrDrop(json, key, peer);
      if (incoming === null) continue;
      const current = this.view.state.get(key);
      const merged = current ? current.merge(incoming) : incoming;
      this.applyMerged(key, current ?? null, merged);
    }
  }

  /**
   * Decode a peer-supplied CRDT, or drop it.
   *
   * `decodeCrdt` validates and therefore *throws* on a malformed or hostile
   * payload.  Every call site here is a wire handler, and an exception out of
   * one is an actor failure: twelve of them exhausted this actor's restart
   * budget and terminated DistributedData for the life of the process, taking
   * every unsettled read and write promise with it (#699, #721).
   *
   * Dropping is the right answer for a state-based CRDT — a lost gossip entry
   * is re-sent on the next tick, so a transient garble costs a round and
   * nothing else.  It is logged rather than silent because the only thing that
   * produces one is a peer that is broken or hostile, and neither should be
   * invisible; the log names the peer and the key so it can be traced back.
   */
  private decodeOrDrop(json: CrdtJson, key: string, peer: NodeAddress): Crdt<any> | null {
    try {
      return decodeCrdt(json, this.identityFor(key));
    } catch (e) {
      this.droppedFrames++;
      this.countDroppedFrame();
      this.log.warn(
        `DistributedData: dropping an undecodable value for "${key}" from ${peer.toString()} `
        + `(${this.droppedFrames} dropped so far)`,
        e,
      );
      return null;
    }
  }

  /**
   * The identity to decode `key` under, or `undefined` while none is known.
   *
   * `undefined` is the honest answer for a key the application has never
   * updated: nothing in a frame, and nothing in the durable record, says what
   * a value's identity should be.  {@link learnIdentity} is what repairs such
   * a value once the application does say.
   */
  private identityFor(key: string): CrdtIdentityFunction | undefined {
    return this.identities.get(key) ?? undefined;
  }

  /**
   * Take `key`'s identity from the caller's factory, and repair a value that
   * was materialised before it was known.
   *
   * Once per key, because the answer cannot change: `update` for a key we
   * already know returns on the first line, so the common path costs a map
   * lookup and the caller's factory is not invoked a second time.
   *
   * The repair is the half that fixes a **durable reload** and a
   * **gossip-first** key, and it is not optional in the way it looks.  Both
   * put a value in the view before any factory has been seen — `preStart`
   * decodes the durable record before the mailbox is drained, and a peer
   * gossips a key whenever it likes — so threading the identity into the
   * decoders alone would leave exactly the two cases the issue reports.  One
   * encode/decode round through the wire form is the whole repair, because
   * `fromJSON` now files every entry under the identity it is given; entries
   * that were separate under `JSON.stringify` and share a key under the
   * caller's identity merge, rather than surviving as duplicates forever.
   *
   * The repaired value goes back through {@link applyMerged} rather than
   * straight into the view, because a repair is a real change when it lands:
   * two entries the sender kept apart can collapse into one, and that has to
   * reach the subscribers and the durable record like any other merge would.
   * When nothing moved — the ordinary case — the encoded forms match and
   * `applyMerged` skips both.
   *
   * **Deriving the identity and repairing the value are separate failures and
   * are handled separately.**  A `factory` or a `customIdentity` that throws
   * means the identity genuinely is not known, so nothing is learned and the
   * caller finds out anyway — the very next line of `onUpdate` calls the same
   * factory when the key is absent.  A *repair* that throws means the opposite:
   * the identity came back fine and is now known, and only the value already in
   * the view resisted being re-filed under it.  Unlearning there put the whole
   * of #766 back, silently: the repair throws on a peer-supplied element the
   * callback refuses — the untrusted input this subsystem exists to survive —
   * and once the entry is deleted the next `update` re-derives, throws in the
   * same place and deletes again, so the configured rule is off for the life of
   * the key and deduplication is back on `JSON.stringify`.  Escalating instead
   * is not the alternative either; a throw out of here is an actor failure, and
   * twelve of those terminate DistributedData (#699, #721).
   */
  private learnIdentity(key: string, factory: CrdtFactory<Crdt<any>>): void {
    if (this.identities.has(key)) return;
    let identity: CrdtIdentityFunction | null;
    try {
      identity = factory().customIdentity?.() ?? null;
    } catch (e) {
      this.log.warn(
        `DistributedData: could not derive the element identity for "${key}" from its factory`, e,
      );
      return;
    }
    this.identities.set(key, identity);
    if (identity === null) return;
    this.repairKeying(key, identity);
  }

  /**
   * Re-file `key`'s current value under `identity` — the one encode/decode
   * round that puts a gossip-first or durable-reloaded value right.
   *
   * The second attempt is what keeps an element the callback refuses from
   * costing the whole key its identity.  Which is not the only option, so:
   *
   *   - *Unlearning* is what this method replaced, and it is the defect above.
   *   - *Retrying on the next `update`* buys nothing and costs a decode every
   *     time.  The condition is not transient the way a garbled frame is — the
   *     refused element sits in the local view, and nothing removes it, since
   *     `remove` would have to name it with the same callback that refuses it.
   *   - *Dropping the element* would make a decode lose data a peer committed,
   *     which is not a decoder's decision to take.
   *
   * So the element stays, under the key it arrived with, and every element the
   * callback *can* name is re-keyed around it.  Those are the same string here:
   * a value materialised before its identity was known was decoded with no
   * identity, so its elements are already filed under `JSON.stringify`, which
   * is exactly what the fallback answers.  The refused element therefore does
   * not move, its tombstones stay with it, and the value stays self-consistent
   * — mixed-keyed, but every key is some element's real key.
   *
   * A later merge survives that mixed state because a merge unions by key
   * string and never re-runs an identity.  What the registry keeps is the
   * caller's own function, **not** the lenient wrapper: a frame that arrives
   * later carrying an element the callback refuses is still dropped by
   * {@link decodeOrDrop}.  That asymmetry is deliberate — an element already in
   * the view was accepted before the rule that governs it was known, so
   * refusing it now would be data loss, while refusing a fresh frame loses
   * nothing that was ever accepted.
   */
  private repairKeying(key: string, identity: CrdtIdentityFunction): void {
    const current = this.view.state.get(key);
    if (current === undefined) return;
    const json = current.toJSON() as CrdtJson;
    let repaired: Crdt<any>;
    try {
      repaired = decodeCrdt(json, identity);
    } catch (e) {
      this.log.warn(
        `DistributedData: "${key}" holds an element the configured identity refuses — it keeps `
        + `the key it arrived with, every other element is re-keyed around it, and the identity `
        + `stays in force for this key`,
        e,
      );
      try {
        repaired = decodeCrdt(json, withDefaultKeyForRefusedElements(identity));
      } catch (second) {
        this.log.warn(
          `DistributedData: "${key}" could not be re-keyed at all — its value is left exactly as `
          + `it was, and the identity still governs every later decode for this key`,
          second,
        );
        return;
      }
    }
    this.applyMerged(key, current, repaired);
  }

  private applyMerged(key: string, prev: Crdt<any> | null, next: Crdt<any>): void {
    // Skip the listener fan-out if the merge was a no-op.  Compare by
    // JSON shape — every CRDT's toJSON is a stable structural form.
    const prevJson = prev ? JSON.stringify(prev.toJSON()) : null;
    const nextJson = JSON.stringify(next.toJSON());
    this.view.state.set(key, next);
    if (prevJson === nextJson) return;
    // Persist the change.  If we're recovering from durable load
    // (preStart loop), this re-saves the same state we just loaded
    // — harmless and keeps the code path uniform.
    this.scheduleDurableSave();
    const listeners = this.view.listeners.get(key);
    if (!listeners) return;
    for (const listener of listeners) {
      try { listener(next); } catch (e) {
        this.log.warn(`DistributedData: subscriber for "${key}" threw`, e);
      }
    }
  }

  /**
   * Fire a durable save off the actor mailbox.  Coalesces overlapping
   * requests: if a save is already in flight, we mark `durableDirty`
   * and the in-flight save's `.finally` handler kicks off a follow-up.
   * Net effect: a burst of mutations produces 1-2 disk writes, not N.
   */
  private scheduleDurableSave(): void {
    if (!this.durable) return;
    if (this.durableSaveInFlight) {
      this.durableDirty = true;
      return;
    }
    this.durableSaveInFlight = true;
    const snapshot = new Map(this.view.state);
    void this.durable.save(snapshot)
      .catch((err) => {
        this.log.warn(`DistributedData: durable save failed`, err);
      })
      .finally(() => {
        this.durableSaveInFlight = false;
        if (this.durableDirty) {
          this.durableDirty = false;
          this.scheduleDurableSave();
        }
      });
  }

  /**
   * Push local state to one random peer — as much of it as fits one frame.
   *
   * This used to serialise the whole key set unconditionally, and nothing on
   * the send path checked a size: `Transport.writeFrame` guards
   * serialisability only, and `encodeFrame` writes the length into the header
   * without comparing it to anything.  Past the receiver's `maxFrameBytes` the
   * frame is then rejected on its 4-byte length prefix, *before* a single
   * payload byte is buffered, and the transport answers that decoder throw by
   * dropping the association.  So an oversized store did not gossip slowly: it
   * did not gossip at all — no key ever reached `onGossip` — while killing one
   * peer link per tick, taking heartbeats, membership gossip and every
   * cross-node `tell` on that connection with it, then reconnecting and doing
   * it again a second later (#691).
   *
   * Slicing is sound here and only here.  `onGossip` merges **per key** and
   * treats an absent key as "no information" — there is no deletion pass and
   * no wholesale replacement — so a partial `entries` map costs a round rather
   * than agreement, and CRDT merge being idempotent means a key re-sent on the
   * next sweep costs nothing.  The sibling gossip paths in `Receptionist` and
   * `DistributedPubSubMediator` replace a peer's contribution wholesale, so
   * the same trick would read as deregistration there.
   */
  private gossipTick(): void {
    const peers = this.cluster.upMembers()
      .filter((m) => !m.address.equals(this.cluster.selfAddress));
    if (peers.length === 0) return;
    if (this.view.state.size === 0) return;
    const entries = this.packGossipEntries();
    if (entries === null) return;
    const payload: DDataGossipMessage = {
      kind: 'ddata-gossip',
      from: this.cluster.selfAddress.toJSON(),
      entries,
    };
    const target = peers[Math.floor(Math.random() * peers.length)]!;
    this.cluster.transport.send(target.address, payload as unknown as WireMessage);
  }

  /**
   * Fill one gossip frame from the cursor onwards, or `null` when not one key
   * could go in it.
   *
   * The accounting is per entry and deliberately errs high — see
   * {@link measureGossipEntry} — so the frame `encodeFrame` goes on to produce
   * is never larger than the budget this measured against.  Measuring the
   * assembled frame instead would be exact and useless: by then the only
   * available answer is "too big", with nothing to say about which key to
   * leave behind.
   */
  private packGossipEntries(): Record<string, CrdtJson> | null {
    const keys = Array.from(this.view.state.keys());
    if (keys.length === 0) return null;
    const budget = this.gossipBudgetBytes();
    const envelopeBytes = this.gossipEnvelopeBytes();
    const packed: Array<readonly [string, CrdtJson]> = [];
    const skips: GossipSkipTally = { oversize: 0, unserialisable: 0, largest: null };
    const start = this.gossipCursor % keys.length;
    let used = envelopeBytes;
    let advance = 0;
    for (let visited = 0; visited < keys.length; visited++) {
      const key = keys[(start + visited) % keys.length]!;
      const measured = this.measureGossipEntry(key);
      if (measured === null) {
        skips.unserialisable++;
        this.countGossipSkip('unserialisable');
        advance++;
        continue;
      }
      // Order matters: a key too large for a frame of its own has to be
      // stepped over, not waited for.  Treated as "does not fit right now" it
      // would park the cursor on itself, and every key behind it would starve
      // for the life of the process — turning one divergent key into a store
      // that stops converging, which is the defect this method exists to fix.
      if (envelopeBytes + measured.bytes > budget) {
        skips.oversize++;
        if (!skips.largest || measured.bytes > skips.largest.bytes) {
          skips.largest = { key, bytes: measured.bytes };
        }
        this.countGossipSkip('oversize');
        advance++;
        continue;
      }
      if (used + measured.bytes > budget) break;
      used += measured.bytes;
      packed.push([key, measured.json] as const);
      advance++;
    }
    // Advance by exactly what this tick consumed, wrapping — that is what
    // makes successive ticks sweep the whole key set instead of re-sending the
    // same head of it forever.
    this.gossipCursor = (start + advance) % keys.length;
    this.reportGossipSkips(skips, budget);
    if (packed.length === 0) return null;
    // `Object.fromEntries`, not `out[key] = …`: a store key is an application
    // string, and for the one value `__proto__` an assignment invokes the
    // inherited setter instead of creating a property.  The key vanished from
    // every outbound frame while `get`/`keys` still reported it locally — a
    // replica diverging from the cluster with nothing logged anywhere (#767).
    return Object.fromEntries(packed) as Record<string, CrdtJson>;
  }

  /**
   * What one entry adds to the frame's payload, or `null` when it cannot be
   * encoded at all.
   *
   * The measurement mirrors `encodeFrame` exactly — `encodeJsonTree` with
   * `undefinedValues: 'omit'`, then `JSON.stringify`, then UTF-8 — because a
   * budget checked against a different serialisation than the one that reaches
   * the socket is not a budget.  The tagged-tree walk matters: a `Date` or a
   * `Uint8Array` inside an `LWWRegister` value encodes to a wrapper object
   * several times its `JSON.stringify` length, so measuring the plain form
   * would come in low on exactly the payloads that overflow.
   *
   * `"key":value,` — the trailing comma is counted for every entry, so the sum
   * lands one byte *above* what the encoder emits (it writes one comma fewer
   * than there are entries).  Erring high is the property that has to hold:
   * the receiver's cap is compared with `>`, so a bound that could come in low
   * would let the frame through at the exact size that kills the link.
   *
   * `null` rather than a throw because the caller is a timer with nothing to
   * unwind into, and because a throw here would be strictly worse than what it
   * replaced: `writeFrame` catches the same failure today and drops the
   * *entire* frame, so one unserialisable user value inside an `LWWRegister`
   * silences every other key that travelled with it.
   */
  private measureGossipEntry(key: string): MeasuredGossipEntry | null {
    const crdt = this.view.state.get(key);
    if (!crdt) return null;
    try {
      const json = crdt.toJSON() as CrdtJson;
      const encoded = JSON.stringify(encodeJsonTree(json, { undefinedValues: 'omit' }));
      const bytes = utf8.encode(JSON.stringify(key)).byteLength + 1
        + utf8.encode(encoded).byteLength + 1;
      return { json, bytes };
    } catch {
      return null;
    }
  }

  /**
   * Effective budget for one gossip frame's payload.
   *
   * The smaller of the configured budget and the transport's own per-frame
   * cap, and the clamp is the load-bearing half.  Lowering
   * `actor-ts.remote.max-frame-bytes` is the documented advice for a network
   * crossing a semi-trusted boundary (`ClusterOptions.maxFrameBytes`), and a
   * DistributedData budget that ignored it would keep emitting frames the peer
   * now rejects on the length prefix — the original defect, reachable purely
   * by configuration.
   *
   * Read per tick rather than resolved once: the transport is a constructor
   * argument to `Cluster` and could be replaced by a caller between ticks, and
   * one property read is not worth a staleness hazard.
   *
   * `undefined` from the transport means it frames nothing — the in-memory,
   * `MessageChannel` and multi-node transports hand the message object over —
   * so there is no length prefix to overflow and only the configured budget
   * applies.
   */
  private gossipBudgetBytes(): number {
    const configured = this.maxGossipBytes === 0
      ? Number.POSITIVE_INFINITY
      : this.maxGossipBytes;
    const frameCap = this.cluster.transport.maxFrameBytes ?? Number.POSITIVE_INFINITY;
    return Math.min(configured, frameCap);
  }

  /**
   * Payload bytes a gossip frame costs before any entry goes into it — the
   * `kind`, the sender address and the empty `entries` object.  Subtracted
   * from the budget so the per-entry sum is compared against the room that
   * actually exists, and measured rather than estimated because the sender
   * address is a variable-length host and port.
   */
  private gossipEnvelopeBytes(): number {
    const empty: DDataGossipMessage = {
      kind: 'ddata-gossip',
      from: this.cluster.selfAddress.toJSON(),
      entries: {},
    };
    const encoded = JSON.stringify(encodeJsonTree(empty, { undefinedValues: 'omit' }));
    return utf8.encode(encoded).byteLength;
  }

  /**
   * Say once per {@link GOSSIP_SKIP_WARN_INTERVAL_MS} that keys are being
   * left out, and what it costs.
   *
   * Loud on purpose, and rate-limited for the same reason: a key past the
   * budget does not converge, which is a silent divergence unless something
   * says so — but the condition is rediscovered on every gossip tick and
   * persists for as long as the key does, so per-occurrence logging would be a
   * line a second forever and end with the category filtered out.  The running
   * total is carried in the line so a suppressed window still shows up in the
   * next one; the exact series is
   * `distributed_data_gossip_skipped_keys_total`.
   */
  private reportGossipSkips(skips: GossipSkipTally, budget: number): void {
    const total = skips.oversize + skips.unserialisable;
    if (total === 0) return;
    this.gossipSkips += total;
    const now = Date.now();
    if (now - this.lastGossipSkipWarnAtMs < GOSSIP_SKIP_WARN_INTERVAL_MS) return;
    this.lastGossipSkipWarnAtMs = now;
    const largest = skips.largest;
    this.log.warn(
      `DistributedData: left ${total} of ${this.view.state.size} key(s) out of gossip — `
      + `${skips.oversize} above the ${budget}-byte frame budget, `
      + `${skips.unserialisable} unserialisable (${this.gossipSkips} since start)`
      + (largest ? `; largest is "${largest.key}" at ${largest.bytes} bytes` : '')
      + `. Such a key cannot be gossiped at all, so this replica will not `
      + `converge on it: raise actor-ts.distributed-data.max-gossip-bytes `
      + `(and actor-ts.remote.max-frame-bytes with it) or split the value.`,
    );
  }

  private countGossipSkip(reason: GossipSkipReason): void {
    metricsOf(this.system).counter(
      'distributed_data_gossip_skipped_keys_total', { reason },
      { help: 'Local keys a gossip frame could not carry — over the frame budget, or unserialisable.' },
    ).inc();
  }
}

/* ============================== helpers ============================== */

/**
 * Correlates a quorum read or write with the acknowledgments that answer it.
 *
 * Was `p${Date.now()}-${++counter}`.  This value goes onto the wire, and the
 * peer replies with the same one so the originator can match it up — so a
 * predictable id is an invitation: guess one that is in flight and a forged
 * acknowledgment counts toward a quorum that no peer actually gave.  A
 * timestamp is observable and a counter starts at 1 in every process, which
 * makes guessing arithmetic rather than search.
 *
 * The counter was also module-global rather than per-system, so two systems in
 * one process drew from the same sequence.  Sixteen hex characters are ~64
 * bits, far past the number of quorum requests in flight at once — the only
 * uniqueness that has to hold.
 */
function nextPendingId(): string {
  return `p${randomId(16)}`;
}

/**
 * Translate a {@link WriteConsistency} / {@link ReadConsistency} value
 * into the integer ack count required, given the current up-member
 * cluster size `N` (incl. self).
 *
 *   - `'local'`     → 1            (just self)
 *   - `'majority'`  → floor(N/2)+1
 *   - `'all'`       → N
 *   - `{ from: K }` → clamp(K, 1, N)
 */
function clampQuorum(consistency: WriteConsistency | ReadConsistency, totalN: number): number {
  if (consistency === 'local') return 1;
  if (consistency === 'majority') return Math.floor(totalN / 2) + 1;
  if (consistency === 'all') return totalN;
  // { from: K }
  const fromCount = Math.trunc(consistency.from);
  if (!Number.isFinite(fromCount) || fromCount < 1) return 1;
  if (fromCount > totalN) return totalN;
  return fromCount;
}
