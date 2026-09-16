import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { wireFrameProblem } from '../../../src/cluster/WireValidation.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  PARALLELISM_WIRE_KINDS,
  serveParallelism,
  type ParallelismSpawnMessage,
} from '../../../src/parallelism/SpawnProtocol.js';
import { Where } from './__fixtures__/actors.js';

/**
 * The worker's half of the spawn protocol (#1563) against a stand-in
 * cluster: what it answers, what it refuses, and whom it listens to.  The
 * happy path over a real node is the extension suite's.
 */

type Sent = { readonly to: string; readonly message: Record<string, unknown> };

function stubCluster(self: NodeAddress): { cluster: Cluster; sent: Sent[]; handlers: Map<string, (m: WireMessage, from: NodeAddress) => void> } {
  const sent: Sent[] = [];
  const handlers = new Map<string, (m: WireMessage, from: NodeAddress) => void>();
  const cluster = {
    selfAddress: self,
    _onWire(kind: string, handler: (m: WireMessage, from: NodeAddress) => void): () => void {
      handlers.set(kind, handler);
      return () => { handlers.delete(kind); };
    },
    _sendWire(to: NodeAddress, message: WireMessage): void {
      sent.push({ to: to.toString(), message: message as unknown as Record<string, unknown> });
    },
  } as unknown as Cluster;
  return { cluster, sent, handlers };
}

const MAIN = new NodeAddress('proto', 'main', 1);
const STRANGER = new NodeAddress('proto', 'elsewhere', 9);
const SELF = new NodeAddress('proto', 'worker', 2);

async function withService(body: (context: {
  system: ActorSystem;
  sent: Sent[];
  spawn: (message: Partial<ParallelismSpawnMessage>, from?: NodeAddress) => void;
  terminate: (from?: NodeAddress) => void;
}) => Promise<void>): Promise<void> {
  const system = ActorSystem.create('proto', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const { cluster, sent, handlers } = stubCluster(SELF);
  const unsubscribe = serveParallelism({ system, cluster, actors: new Map([['Where', Where]]), trustedPeers: [MAIN.toString()] });
  try {
    await body({
      system,
      sent,
      spawn: (message, from = MAIN) =>
        handlers.get('parallelism-spawn')!({ kind: 'parallelism-spawn', ...message } as unknown as WireMessage, from),
      terminate: (from = MAIN) =>
        handlers.get('parallelism-terminate')!({ kind: 'parallelism-terminate' } as unknown as WireMessage, from),
    });
  } finally {
    unsubscribe();
    expect(handlers.size).toBe(0);
    await system.terminate();
  }
}

describe('parallelism wire kinds', () => {
  test('every kind is an extension kind: the core validator passes it through to the registered handler', () => {
    expect(PARALLELISM_WIRE_KINDS).toHaveLength(5);
    for (const kind of PARALLELISM_WIRE_KINDS) expect(wireFrameProblem({ kind })).toBeNull();
  });
});

describe('the worker side of the spawn protocol', () => {
  test('a spawn from the main thread creates the actor under /user and is acknowledged with its path', () => withService(async ({ system, sent, spawn }) => {
    spawn({ requestId: 'r1', name: 'where', nameSource: 'caller', actorClass: 'Where' });
    expect(sent).toEqual([{ to: MAIN.toString(), message: { kind: 'parallelism-spawned', requestId: 'r1', path: 'actor-ts://proto/user/where' } }]);
    expect(system._inspectTree().some((cell) => cell.path === 'actor-ts://proto/user/where')).toBe(true);
    // A generated name carries the reserved prefix and is created the way spawnAnonymous would.
    spawn({ requestId: 'r2', name: '$generated-1', nameSource: 'generated', actorClass: 'Where' });
    expect(sent[1]!.message).toEqual({ kind: 'parallelism-spawned', requestId: 'r2', path: 'actor-ts://proto/user/$generated-1' });
  }));

  test('a spawn from anyone but the main thread is dropped without an answer', () => withService(async ({ system, sent, spawn, terminate }) => {
    spawn({ requestId: 'r1', name: 'where', nameSource: 'caller', actorClass: 'Where' }, STRANGER);
    terminate(STRANGER);
    expect(sent).toEqual([]);
    expect(system._inspectTree().some((cell) => cell.path.endsWith('/user/where'))).toBe(false);
    expect(system._isTerminating()).toBe(false);
  }));

  test('a malformed frame is refused when it can be answered, and dropped when it cannot', () => withService(async ({ sent, spawn }) => {
    spawn({ requestId: 'r1', name: '', nameSource: 'caller', actorClass: 'Where' });
    spawn({ requestId: 'r2', name: 'x', nameSource: 'nobody' as never, actorClass: 'Where' });
    spawn({ requestId: 'r3', name: 'x', nameSource: 'caller', actorClass: '' });
    spawn({ requestId: 'r4', name: 'x', nameSource: 'caller', actorClass: 'Where', options: 42 as never });
    spawn({ name: 'x', nameSource: 'caller', actorClass: 'Where' });
    expect(sent.map((s) => s.message.kind)).toEqual(Array(4).fill('parallelism-spawn-failed'));
    expect(sent.map((s) => s.message.requestId)).toEqual(['r1', 'r2', 'r3', 'r4']);
  }));

  test('an unknown class and a name the guardian refuses are refused with the reason, and the registry is listed', () => withService(async ({ sent, spawn }) => {
    spawn({ requestId: 'r1', name: 'x', nameSource: 'caller', actorClass: 'Nope' });
    const refusal = sent[0]!.message;
    expect(refusal.kind).toBe('parallelism-spawn-failed');
    expect(refusal.reason).toContain("'Nope'");
    expect(refusal.reason).toContain('Where');
    spawn({ requestId: 'r2', name: 'twice', nameSource: 'caller', actorClass: 'Where' });
    spawn({ requestId: 'r3', name: 'twice', nameSource: 'caller', actorClass: 'Where' });
    expect(sent[2]!.message.kind).toBe('parallelism-spawn-failed');
    expect(sent[2]!.message.reason).toContain('not unique');
  }));

  test('terminate from the main thread terminates the system and answers once it is down', () => withService(async ({ system, sent, terminate }) => {
    terminate();
    await system.whenTerminated();
    expect(sent.at(-1)!.message).toEqual({ kind: 'parallelism-terminated' });
    expect(sent.at(-1)!.to).toBe(MAIN.toString());
  }));
});
