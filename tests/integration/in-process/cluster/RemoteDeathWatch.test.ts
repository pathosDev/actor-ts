import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { RemoteActorRef } from '../../../../src/cluster/RemoteActorRef.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Terminated } from '../../../../src/SystemMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/**
 * Death watch across a node boundary (#918), and the sender that rides along
 * with every envelope (#1561) — both on the in-process rig: two real
 * `Cluster`s over an `InMemoryTransport`, both ends on this thread, so the
 * whole wire protocol runs with no OS thread anywhere.
 *
 * Every absence is asserted through ordering rather than through a wait:
 * frames from one node to another are delivered in order, so "the second
 * death arrived and the first never did" is a fact, not a timeout.
 */

const waitFor = (
  predicate: () => boolean,
  label: string,
): Promise<void> => awaitCondition(predicate, { timeoutMs: 5_000, intervalMs: 20, label });

type Node = { readonly system: ActorSystem; readonly cluster: Cluster; readonly address: NodeAddress };

let portSeed = 59_100;

async function startNode(systemName: string, seeds: string[] = []): Promise<Node> {
  const port = portSeed++;
  const address = new NodeAddress(systemName, 'h', port);
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(address))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

async function twoNodes(systemName: string): Promise<[Node, Node]> {
  const a = await startNode(systemName);
  const b = await startNode(systemName, [a.address.toString()]);
  await waitFor(
    () => a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2,
    'both nodes up',
  );
  return [a, b];
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

/** Lives on the far node; stops on request so a watcher has something to see. */
class Subject extends Actor<'stop'> {
  override onReceive(): void { this.context.stopSelf(); }
}

type WatcherCommand =
  | { kind: 'watch'; subject: ActorRef }
  | { kind: 'watchWith'; subject: ActorRef; message: string }
  | { kind: 'unwatch'; subject: ActorRef }
  | Terminated
  | string;

/** Records every `Terminated` and every custom watch message it is handed. */
class Watcher extends Actor<WatcherCommand> {
  readonly terminations: Terminated[] = [];
  readonly custom: string[] = [];

  override onReceive(command: WatcherCommand): void {
    if (command instanceof Terminated) { this.terminations.push(command); return; }
    if (typeof command === 'string') { this.custom.push(command); return; }
    if (command.kind === 'watch') this.context.watch(command.subject);
    else if (command.kind === 'watchWith') this.context.watchWith(command.subject, command.message);
    else this.context.unwatch(command.subject);
  }
}

function remoteRef<T>(node: Node, target: Node, path: string): RemoteActorRef<T> {
  return new RemoteActorRef<T>(target.address, path, node.cluster);
}

describe('death watch across nodes (#918)', () => {
  test('a watched remote actor that stops delivers Terminated with the ref that was watched', async () => {
    const [a, b] = await twoNodes('rdw-stop');
    try {
      const subject = b.system.spawn(Subject, 'subject');
      let watcherInstance: Watcher | null = null;
      const watcher = a.system.spawn(() => (watcherInstance = new Watcher()), 'watcher');
      const remote = remoteRef<'stop'>(a, b, subject.path.toString());
      watcher.tell({ kind: 'watch', subject: remote });

      remote.tell('stop');
      await waitFor(() => watcherInstance?.terminations.length === 1, 'Terminated arrived on node A');

      const terminated = watcherInstance!.terminations[0]!;
      expect(terminated.actor).toBe(remote);
      expect(terminated.existenceConfirmed).toBe(true);
      expect(terminated.addressTerminated).toBe(false);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);

  test('watching a path that does not exist on the far node answers at once with existenceConfirmed false', async () => {
    const [a, b] = await twoNodes('rdw-missing');
    try {
      let watcherInstance: Watcher | null = null;
      const watcher = a.system.spawn(() => (watcherInstance = new Watcher()), 'watcher');
      const ghost = remoteRef<unknown>(a, b, `actor-ts://rdw-missing/user/nobody-here`);
      watcher.tell({ kind: 'watch', subject: ghost });

      await waitFor(() => watcherInstance?.terminations.length === 1, 'Terminated for the missing actor');
      expect(watcherInstance!.terminations[0]!.actor).toBe(ghost);
      expect(watcherInstance!.terminations[0]!.existenceConfirmed).toBe(false);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);

  test('watchWith delivers the custom message instead of Terminated', async () => {
    const [a, b] = await twoNodes('rdw-with');
    try {
      const subject = b.system.spawn(Subject, 'subject');
      let watcherInstance: Watcher | null = null;
      const watcher = a.system.spawn(() => (watcherInstance = new Watcher()), 'watcher');
      const remote = remoteRef<'stop'>(a, b, subject.path.toString());
      watcher.tell({ kind: 'watchWith', subject: remote, message: 'subject-lost' });

      remote.tell('stop');
      await waitFor(() => watcherInstance?.custom.length === 1, 'the custom message arrived');
      expect(watcherInstance!.custom).toEqual(['subject-lost']);
      expect(watcherInstance!.terminations).toHaveLength(0);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);

  test('unwatch before the stop suppresses the notification (ordered against a kept watch)', async () => {
    const [a, b] = await twoNodes('rdw-unwatch');
    try {
      const dropped = b.system.spawn(Subject, 'dropped');
      const kept = b.system.spawn(Subject, 'kept');
      let watcherInstance: Watcher | null = null;
      const watcher = a.system.spawn(() => (watcherInstance = new Watcher()), 'watcher');
      const droppedRemote = remoteRef<'stop'>(a, b, dropped.path.toString());
      const keptRemote = remoteRef<'stop'>(a, b, kept.path.toString());
      watcher.tell({ kind: 'watch', subject: droppedRemote });
      watcher.tell({ kind: 'watch', subject: keptRemote });
      watcher.tell({ kind: 'unwatch', subject: droppedRemote });

      // `dropped` stops first, `kept` second; node B's frames to node A are
      // delivered in order, so once `kept`'s Terminated is here, `dropped`'s
      // would have arrived before it if it was ever sent.
      droppedRemote.tell('stop');
      keptRemote.tell('stop');
      await waitFor(() => (watcherInstance?.terminations.length ?? 0) >= 1, 'the kept watch fired');
      expect(watcherInstance!.terminations.map((t) => t.actor)).toEqual([keptRemote]);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);

  test('the far node leaving delivers Terminated with addressTerminated set, without the actor ever stopping', async () => {
    const [a, b] = await twoNodes('rdw-node-loss');
    try {
      const subject = b.system.spawn(Subject, 'subject');
      let watcherInstance: Watcher | null = null;
      const watcher = a.system.spawn(() => (watcherInstance = new Watcher()), 'watcher');
      const remote = remoteRef<'stop'>(a, b, subject.path.toString());
      watcher.tell({ kind: 'watch', subject: remote });
      // Make sure the watch frame has landed before B goes, so what is
      // tested is node loss and not a watch that never registered.
      await waitFor(() => b.cluster.upMembers().length === 2, 'node B is up');

      await b.cluster.leave();
      await waitFor(() => watcherInstance?.terminations.length === 1, 'node loss surfaced as Terminated');
      const terminated = watcherInstance!.terminations[0]!;
      expect(terminated.actor).toBe(remote);
      expect(terminated.addressTerminated).toBe(true);
      expect(terminated.existenceConfirmed).toBe(true);
    } finally {
      await b.system.terminate();
      await stopNode(a);
    }
  }, 15_000);

  test('a /system path cannot be watched by name — it is answered as nonexistent', async () => {
    const [a, b] = await twoNodes('rdw-system');
    try {
      let watcherInstance: Watcher | null = null;
      const watcher = a.system.spawn(() => (watcherInstance = new Watcher()), 'watcher');
      // `/system` itself always exists, so an answer of "never seen" here can
      // only come from the trust policy, never from resolution.
      const guardian = remoteRef<unknown>(a, b, 'actor-ts://rdw-system/system');
      watcher.tell({ kind: 'watch', subject: guardian });

      await waitFor(() => watcherInstance?.terminations.length === 1, 'the refused watch was answered');
      expect(watcherInstance!.terminations[0]!.existenceConfirmed).toBe(false);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);

  test('two local watchers of one remote actor are both told, through one watch frame', async () => {
    const [a, b] = await twoNodes('rdw-two-watchers');
    try {
      const subject = b.system.spawn(Subject, 'subject');
      const instances: Watcher[] = [];
      const first = a.system.spawn(() => { const w = new Watcher(); instances.push(w); return w; }, 'first');
      const second = a.system.spawn(() => { const w = new Watcher(); instances.push(w); return w; }, 'second');
      const remote = remoteRef<'stop'>(a, b, subject.path.toString());
      first.tell({ kind: 'watch', subject: remote });
      second.tell({ kind: 'watch', subject: remote });

      remote.tell('stop');
      await waitFor(
        () => instances.length === 2 && instances.every((w) => w.terminations.length === 1),
        'both watchers on node A were told',
      );
      for (const w of instances) expect(w.terminations[0]!.actor).toBe(remote);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);
});

type EchoCommand = { kind: 'hello'; from: string };

/** Replies through `context.sender`, which is the whole point of #1561. */
class SenderEcho extends Actor<EchoCommand> {
  senderPaths: string[] = [];
  override onReceive(command: EchoCommand): void {
    this.senderPaths.push(this.sender.map((s) => s.path.toString()).getOrElse('none'));
    this.sender.forEach((s) => s.tell(`echo:${command.from}`));
  }
}

class Caller extends Actor<string> {
  readonly replies: string[] = [];
  override onReceive(reply: string): void { this.replies.push(reply); }
}

describe('the sender crosses the wire (#1561)', () => {
  test('context.sender on the receiving node names the remote sender, and a reply through it arrives', async () => {
    const [a, b] = await twoNodes('rs-sender');
    try {
      let echoInstance: SenderEcho | null = null;
      const echo = b.system.spawn(() => (echoInstance = new SenderEcho()), 'echo');
      let callerInstance: Caller | null = null;
      const caller = a.system.spawn(() => (callerInstance = new Caller()), 'caller');
      const remote = remoteRef<EchoCommand>(a, b, echo.path.toString());

      remote.tell({ kind: 'hello', from: 'a' }, caller);
      await waitFor(() => callerInstance?.replies.length === 1, 'the reply via context.sender came back');

      expect(echoInstance!.senderPaths).toEqual([caller.path.toString()]);
      expect(callerInstance!.replies).toEqual(['echo:a']);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);

  test('a tell with no sender still arrives with context.sender empty', async () => {
    const [a, b] = await twoNodes('rs-no-sender');
    try {
      let echoInstance: SenderEcho | null = null;
      const echo = b.system.spawn(() => (echoInstance = new SenderEcho()), 'echo');
      const remote = remoteRef<EchoCommand>(a, b, echo.path.toString());

      remote.tell({ kind: 'hello', from: 'anonymous' });
      await waitFor(() => echoInstance?.senderPaths.length === 1, 'the anonymous tell was received');
      expect(echoInstance!.senderPaths).toEqual(['none']);
    } finally {
      await stopNode(b);
      await stopNode(a);
    }
  }, 15_000);
});
