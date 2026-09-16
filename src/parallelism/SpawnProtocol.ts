import type { ActorOptions } from '../ActorOptions.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cluster } from '../cluster/Cluster.js';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import type { WorkerActorClass } from '../worker/WorkerMeshBootstrap.js';

/**
 * The frames the parallelism extension exchanges with a mesh worker (#1563).
 *
 * Extension kinds, dispatched through `Cluster._onWire` like the receptionist's
 * and pub-sub's gossip: the core validates that a frame has a string `kind`
 * and hands the rest to the handler, so the shape checks live here.  Every
 * value crosses a `MessageChannel`, so every field is structured-cloneable by
 * construction — a class is named by its export name, never sent.
 */

/** Main → worker: create `actorClass` under `/user/<name>`. */
export type ParallelismSpawnMessage = {
  readonly kind: 'parallelism-spawn';
  readonly requestId: string;
  readonly name: string;
  /**
   * Whether the main thread chose the name or generated it for an anonymous
   * spawn.  A generated one starts with the reserved `$`, which a caller may
   * not use — so the worker has to create it the way `spawnAnonymous` would.
   */
  readonly nameSource: 'caller' | 'generated';
  /** The export name the class was registered under on both sides. */
  readonly actorClass: string;
  /** The structured-cloneable subset of the caller's `ActorOptions`, if any. */
  readonly options?: Record<string, unknown>;
};

/** Worker → main: the actor exists at `path`. */
export type ParallelismSpawnedMessage = {
  readonly kind: 'parallelism-spawned';
  readonly requestId: string;
  readonly path: string;
};

/** Worker → main: the spawn was refused, with the reason the caller sees. */
export type ParallelismSpawnFailedMessage = {
  readonly kind: 'parallelism-spawn-failed';
  readonly requestId: string;
  readonly reason: string;
};

/** Main → worker: terminate the worker's system — `postStop` for every offloaded actor. */
export type ParallelismTerminateMessage = {
  readonly kind: 'parallelism-terminate';
};

/** Worker → main: the worker's system is down; the thread can go. */
export type ParallelismTerminatedMessage = {
  readonly kind: 'parallelism-terminated';
};

export type ParallelismWireMessage =
  | ParallelismSpawnMessage
  | ParallelismSpawnedMessage
  | ParallelismSpawnFailedMessage
  | ParallelismTerminateMessage
  | ParallelismTerminatedMessage;

/** Every kind above, for the dead-protocol guard and for handler registration. */
export const PARALLELISM_WIRE_KINDS: ReadonlyArray<ParallelismWireMessage['kind']> = [
  'parallelism-spawn',
  'parallelism-spawned',
  'parallelism-spawn-failed',
  'parallelism-terminate',
  'parallelism-terminated',
];

/**
 * What a worker needs to answer spawn requests: its system, its cluster node,
 * the registry the bootstrap built, and the one peer allowed to ask.
 */
export type ParallelismWorkerContext = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly actors: ReadonlyMap<string, WorkerActorClass>;
  /** Addresses whose spawn and terminate frames are honoured — the mesh's seed, i.e. the main thread. */
  readonly trustedPeers: ReadonlyArray<string>;
};

/**
 * The worker's half of the protocol, installed by the mesh bootstrap once the
 * registry exists.  Frames from anyone but the main thread are dropped: a
 * spawn is "run this registered class under this name", which is nothing a
 * peer other than the thread that owns the mesh may ask for.
 *
 * Returns the unsubscribe for both handlers.
 */
export function serveParallelism(context: ParallelismWorkerContext): () => void {
  const service = new ParallelismWorkerService(context);
  const unsubscribeSpawn = context.cluster._onWire('parallelism-spawn', (message, from) =>
    service.onSpawn(message as unknown as ParallelismSpawnMessage, from),
  );
  const unsubscribeTerminate = context.cluster._onWire('parallelism-terminate', (message, from) =>
    service.onTerminate(message as unknown as ParallelismTerminateMessage, from),
  );
  return () => {
    unsubscribeSpawn();
    unsubscribeTerminate();
  };
}

class ParallelismWorkerService {
  constructor(private readonly context: ParallelismWorkerContext) {}

  onSpawn(message: ParallelismSpawnMessage, from: NodeAddress): void {
    if (!this.isTrusted(from)) return;
    const problem = describeSpawnProblem(message);
    if (problem !== null) {
      // Only when there is a request to answer — a frame with no id has no
      // pending ref waiting for it on the other side.
      if (typeof message.requestId === 'string') this.refuse(from, message.requestId, problem);
      return;
    }
    const actorClass = this.context.actors.get(message.actorClass);
    if (actorClass === undefined) {
      this.refuse(
        from,
        message.requestId,
        `no actor class is exported as '${message.actorClass}' on worker ${this.context.cluster.selfAddress} — `
        + `the module exports: ${[...this.context.actors.keys()].join(', ') || '(none)'}`,
      );
      return;
    }
    try {
      const options = message.options as ActorOptions<unknown> | undefined;
      const ref = message.nameSource === 'generated'
        ? this.context.system._spawnWithGeneratedName(actorClass, message.name, options)
        : this.context.system.spawn(actorClass, message.name, options);
      const spawned: ParallelismSpawnedMessage = {
        kind: 'parallelism-spawned',
        requestId: message.requestId,
        path: ref.path.toString(),
      };
      this.context.cluster._sendWire(from, spawned as unknown as WireMessage);
    } catch (error) {
      this.refuse(from, message.requestId, error instanceof Error ? error.message : String(error));
    }
  }

  onTerminate(_message: ParallelismTerminateMessage, from: NodeAddress): void {
    if (!this.isTrusted(from)) return;
    const done = (): void => {
      const terminated: ParallelismTerminatedMessage = { kind: 'parallelism-terminated' };
      this.context.cluster._sendWire(from, terminated as unknown as WireMessage);
    };
    // Same handler on both settlements: the thread is going to be terminated
    // by the main side once it hears back or gives up, so a teardown that
    // failed must still answer rather than hold the whole shutdown open.
    void this.context.system.terminate().then(done, done);
  }

  private isTrusted(from: NodeAddress): boolean {
    return this.context.trustedPeers.includes(from.toString());
  }

  private refuse(to: NodeAddress, requestId: string, reason: string): void {
    const failed: ParallelismSpawnFailedMessage = { kind: 'parallelism-spawn-failed', requestId, reason };
    this.context.cluster._sendWire(to, failed as unknown as WireMessage);
  }
}

function describeSpawnProblem(message: Partial<ParallelismSpawnMessage> | null): string | null {
  if (message === null || typeof message !== 'object') return 'spawn frame is not an object';
  if (typeof message.requestId !== 'string' || message.requestId.length === 0) return 'spawn frame has no requestId';
  if (typeof message.name !== 'string' || message.name.length === 0) return 'spawn frame has no actor name';
  if (message.nameSource !== 'caller' && message.nameSource !== 'generated') return 'spawn frame has no nameSource';
  if (typeof message.actorClass !== 'string' || message.actorClass.length === 0) return 'spawn frame names no actor class';
  if (message.options !== undefined && (message.options === null || typeof message.options !== 'object')) {
    return 'spawn frame options are not an object';
  }
  return null;
}
