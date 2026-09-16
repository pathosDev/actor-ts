import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { MemberDown, MemberRemoved, MemberUp, type ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import { EnvelopeTrust } from '../../../src/cluster/EnvelopeTrust.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { RemoteActorRef } from '../../../src/cluster/RemoteActorRef.js';
import { RemoteWatcher } from '../../../src/cluster/RemoteWatcher.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Terminated } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * The bookkeeping of `RemoteWatcher` (#918), against a cluster double that
 * records every frame it is asked to send and lets the test raise membership
 * events by hand.  The integration suite
 * (`tests/integration/in-process/cluster/RemoteDeathWatch.test.ts`) proves the
 * protocol end to end; this one proves the halves that are invisible from
 * outside — that a watcher's own death withdraws its watches, that node loss
 * pulls every proxy that node planted, and that `shutdown()` leaves nothing
 * behind in a local cell.
 */

const SELF = new NodeAddress('rw', 'h', 1);
const PEER = new NodeAddress('rw', 'h', 2);

type Sent = { readonly to: NodeAddress; readonly message: WireMessage };

type Rig = {
  readonly system: ActorSystem;
  readonly watcher: RemoteWatcher;
  readonly sent: Sent[];
  emit(event: ClusterEvent): void;
};

function rig(options: { untrusted?: boolean } = {}): Rig {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('rw', systemOptions);
  const sent: Sent[] = [];
  const listeners: Array<(event: ClusterEvent) => void> = [];
  const log = new NoopLogger();
  const fake = {
    system,
    selfAddress: SELF,
    _envelopeTrust: new EnvelopeTrust(system, log, options.untrusted ?? false, []),
    _sendWire(to: NodeAddress, message: WireMessage): void { sent.push({ to, message }); },
    _sendEnvelope(): void { /* a RemoteActorRef is only ever an address here */ },
    subscribe(listener: (event: ClusterEvent) => void): () => void {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
  };
  const cluster = fake as unknown as Cluster;
  const watcher = new RemoteWatcher(cluster, log);
  watcher.start();
  return {
    system,
    watcher,
    sent,
    emit: (event) => { for (const l of [...listeners]) l(event); },
  };
}

class Subject extends Actor<'stop'> {
  override onReceive(): void { this.context.stopSelf(); }
}

type RecorderCommand = { kind: 'watch'; subject: RemoteActorRef } | Terminated;

/**
 * Records every `Terminated`, and registers the watch on its own cell first:
 * the dispatch gate drops a `Terminated` for a ref the cell never watched
 * (#769), so a notification the test injects only lands if the actor's
 * `_watching` map knows the subject.  The system here has no cluster, so
 * `context.watch` records the subject and warns — the test then hands the
 * same ref to the `RemoteWatcher` under test by hand.
 */
class Recorder extends Actor<RecorderCommand> {
  readonly terminations: Terminated[] = [];
  override onReceive(message: RecorderCommand): void {
    if (message instanceof Terminated) { this.terminations.push(message); return; }
    this.context.watch(message.subject);
  }
}

function remote(cluster: Rig, path: string, node: NodeAddress = PEER): RemoteActorRef {
  return new RemoteActorRef(node, path, { system: cluster.system } as unknown as Cluster);
}

const kinds = (sent: Sent[]): string[] => sent.map((s) => s.message.kind);

describe('RemoteWatcher — watcher side', () => {
  test('one watch frame per (peer, path) however many local cells watch it', () => {
    const r = rig();
    const first = r.system.spawn(Recorder, 'first');
    const second = r.system.spawn(Recorder, 'second');
    const subject = remote(r, 'actor-ts://rw/user/x');
    expect(r.watcher.watch(first, subject)).toBe(true);
    expect(r.watcher.watch(second, subject)).toBe(true);
    expect(kinds(r.sent)).toEqual(['watch']);
    expect(r.sent[0]!.to).toBe(PEER);
    expect(r.sent[0]!.message).toEqual({ kind: 'watch', watcher: first.path.toString(), watchee: 'actor-ts://rw/user/x' });
  });

  test('unwatch sends only when the last watcher lets go, naming the watcher the watch frame announced', () => {
    const r = rig();
    const first = r.system.spawn(Recorder, 'first');
    const second = r.system.spawn(Recorder, 'second');
    const subject = remote(r, 'actor-ts://rw/user/x');
    r.watcher.watch(first, subject);
    r.watcher.watch(second, subject);
    r.watcher.unwatch(first, subject);
    expect(kinds(r.sent)).toEqual(['watch']);
    r.watcher.unwatch(second, subject);
    expect(kinds(r.sent)).toEqual(['watch', 'unwatch']);
    // The far side keyed its proxy by `first` — the path the watch carried —
    // so the unwatch has to name `first` even though `second` was last out.
    expect(r.sent[1]!.message).toEqual({ kind: 'unwatch', watcher: first.path.toString(), watchee: 'actor-ts://rw/user/x' });
  });

  test('a watcher that stops withdraws every remote watch it held alone', () => {
    const r = rig();
    const lonely = r.system.spawn(Recorder, 'lonely');
    const shared = r.system.spawn(Recorder, 'shared');
    const x = remote(r, 'actor-ts://rw/user/x');
    const y = remote(r, 'actor-ts://rw/user/y');
    r.watcher.watch(lonely, x);
    r.watcher.watch(lonely, y);
    r.watcher.watch(shared, y);
    r.sent.length = 0;
    r.watcher.unwatchAll(lonely);
    // `x` was lonely's alone → unwatch; `y` is still watched by `shared` → nothing.
    expect(r.sent.map((s) => s.message)).toEqual([
      { kind: 'unwatch', watcher: lonely.path.toString(), watchee: 'actor-ts://rw/user/x' },
    ]);
  });

  test('watch-terminated from the far node reaches every watcher as a branded Terminated carrying the watched ref', async () => {
    const r = rig();
    const instances: Recorder[] = [];
    const first = r.system.spawn(() => { const a = new Recorder(); instances.push(a); return a; }, 'first');
    const second = r.system.spawn(() => { const a = new Recorder(); instances.push(a); return a; }, 'second');
    const subject = remote(r, 'actor-ts://rw/user/x');
    first.tell({ kind: 'watch', subject });
    second.tell({ kind: 'watch', subject });
    r.watcher.watch(first, subject);
    r.watcher.watch(second, subject);
    r.watcher.onWatchTerminated(PEER, {
      kind: 'watch-terminated', watcher: first.path.toString(), watchee: 'actor-ts://rw/user/x', existenceConfirmed: false,
    });
    await awaitCondition(
      () => instances.length === 2 && instances.every((a) => a.terminations.length === 1),
      { timeoutMs: 4_000, label: 'both recorders received Terminated' },
    );
    for (const a of instances) {
      expect(a.terminations[0]!.actor).toBe(subject);
      expect(a.terminations[0]!.existenceConfirmed).toBe(false);
      expect(a.terminations[0]!.addressTerminated).toBe(false);
    }
  });

  test('a subject that is not a remote ref is refused, so the cell can say so', () => {
    const r = rig();
    const local = r.system.spawn(Recorder, 'local');
    const other = r.system.spawn(Recorder, 'other');
    expect(r.watcher.watch(local, other)).toBe(false);
    expect(r.sent).toHaveLength(0);
  });
});

describe('RemoteWatcher — watchee side', () => {
  test('a watch on a live local actor is answered when that actor stops', async () => {
    const r = rig();
    const subject = r.system.spawn(Subject, 'subject');
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee: subject.path.toString() });
    expect(r.sent).toHaveLength(0);
    subject.tell('stop');
    await awaitCondition(() => r.sent.length === 1, { timeoutMs: 4_000, label: 'the death crossed the wire' });
    expect(r.sent[0]!.to).toBe(PEER);
    expect(r.sent[0]!.message).toEqual({
      kind: 'watch-terminated', watcher: 'actor-ts://rw/user/far', watchee: subject.path.toString(), existenceConfirmed: true,
    });
  });

  test('a watch on a path that resolves to nothing is answered at once with existenceConfirmed false', () => {
    const r = rig();
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee: 'actor-ts://rw/user/ghost' });
    expect(r.sent.map((s) => s.message)).toEqual([
      { kind: 'watch-terminated', watcher: 'actor-ts://rw/user/far', watchee: 'actor-ts://rw/user/ghost', existenceConfirmed: false },
    ]);
  });

  test('a watch on a path the trust policy refuses is answered exactly like a missing one', () => {
    const r = rig();
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee: 'actor-ts://rw/system' });
    expect(r.sent.map((s) => s.message)).toEqual([
      { kind: 'watch-terminated', watcher: 'actor-ts://rw/user/far', watchee: 'actor-ts://rw/system', existenceConfirmed: false },
    ]);
  });

  test('under untrusted-mode a /user path off the allow-list is refused the same way', () => {
    const r = rig({ untrusted: true });
    const subject = r.system.spawn(Subject, 'subject');
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee: subject.path.toString() });
    expect(kinds(r.sent)).toEqual(['watch-terminated']);
    expect((r.sent[0]!.message as { existenceConfirmed: boolean }).existenceConfirmed).toBe(false);
  });

  test('an unparseable path is answered as missing rather than resolved against the root', () => {
    const r = rig();
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee: '/user/bare' });
    expect(kinds(r.sent)).toEqual(['watch-terminated']);
  });

  test('unwatch withdraws the proxy, so the later death sends nothing', async () => {
    const r = rig();
    const subject = r.system.spawn(Subject, 'subject');
    const watchee = subject.path.toString();
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee });
    r.watcher.onUnwatch(PEER, { kind: 'unwatch', watcher: 'actor-ts://rw/user/far', watchee });
    // A second, still-watching peer orders the absence: its frame arrives
    // when the subject dies, and the withdrawn one's would have come first.
    const other = new NodeAddress('rw', 'h', 3);
    r.watcher.onWatch(other, { kind: 'watch', watcher: 'actor-ts://rw/user/other', watchee });
    subject.tell('stop');
    await awaitCondition(() => r.sent.length >= 1, { timeoutMs: 4_000, label: 'the kept watch was answered' });
    expect(r.sent.map((s) => s.to)).toEqual([other]);
  });

  test('a repeated watch from the same watcher replaces the proxy instead of stacking a second one', async () => {
    const r = rig();
    const subject = r.system.spawn(Subject, 'subject');
    const frame = { kind: 'watch' as const, watcher: 'actor-ts://rw/user/far', watchee: subject.path.toString() };
    r.watcher.onWatch(PEER, frame);
    r.watcher.onWatch(PEER, frame);
    subject.tell('stop');
    await awaitCondition(() => r.sent.length >= 1, { timeoutMs: 4_000, label: 'the death crossed the wire' });
    expect(kinds(r.sent)).toEqual(['watch-terminated']);
  });
});

describe('RemoteWatcher — node loss and shutdown', () => {
  const member = (address: NodeAddress) => new Member(address, 'up', 1, new Set());

  test('MemberRemoved for the far node tells every watcher, with addressTerminated set', async () => {
    const r = rig();
    let instance: Recorder | null = null;
    const watcher = r.system.spawn(() => (instance = new Recorder()), 'watcher');
    const subject = remote(r, 'actor-ts://rw/user/x');
    watcher.tell({ kind: 'watch', subject });
    r.watcher.watch(watcher, subject);
    r.emit(new MemberRemoved(member(PEER)));
    await awaitCondition(() => instance?.terminations.length === 1, { timeoutMs: 4_000, label: 'node loss surfaced' });
    expect(instance!.terminations[0]!.actor).toBe(subject);
    expect(instance!.terminations[0]!.addressTerminated).toBe(true);
    expect(instance!.terminations[0]!.existenceConfirmed).toBe(true);
  });

  test('MemberDown is enough, and a MemberRemoved after it does not notify twice', async () => {
    const r = rig();
    let instance: Recorder | null = null;
    const watcher = r.system.spawn(() => (instance = new Recorder()), 'watcher');
    const subject = remote(r, 'actor-ts://rw/user/x');
    watcher.tell({ kind: 'watch', subject });
    r.watcher.watch(watcher, subject);
    r.emit(new MemberDown(member(PEER)));
    await awaitCondition(() => instance?.terminations.length === 1, { timeoutMs: 4_000, label: 'the down surfaced' });
    r.emit(new MemberRemoved(member(PEER)));
    // Ordered against a fresh watch on another node: its answer arrives after
    // anything the second event might have produced.
    const later = remote(r, 'actor-ts://rw/user/ghost', new NodeAddress('rw', 'h', 3));
    watcher.tell({ kind: 'watch', subject: later });
    r.watcher.watch(watcher, later);
    r.watcher.onWatchTerminated(new NodeAddress('rw', 'h', 3), {
      kind: 'watch-terminated', watcher: watcher.path.toString(), watchee: 'actor-ts://rw/user/ghost', existenceConfirmed: false,
    });
    await awaitCondition(() => instance!.terminations.length === 2, { timeoutMs: 4_000, label: 'the later watch answered' });
    expect(instance!.terminations.map((t) => t.actor)).toEqual([subject, later]);
  });

  test('a member event for an unrelated node, or an unrelated event, changes nothing', () => {
    const r = rig();
    const watcher = r.system.spawn(Recorder, 'watcher');
    r.watcher.watch(watcher, remote(r, 'actor-ts://rw/user/x'));
    r.emit(new MemberRemoved(member(new NodeAddress('rw', 'h', 9))));
    r.emit(new MemberUp(member(PEER)));
    // Still watching: a later unwatch produces the frame a forgotten watch would not.
    r.watcher.unwatch(watcher, remote(r, 'actor-ts://rw/user/x'));
    expect(kinds(r.sent)).toEqual(['watch', 'unwatch']);
  });

  test('losing the far node withdraws the proxies it planted here', async () => {
    const r = rig();
    const subject = r.system.spawn(Subject, 'subject');
    const watchee = subject.path.toString();
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee });
    r.emit(new MemberRemoved(member(PEER)));
    const other = new NodeAddress('rw', 'h', 3);
    r.watcher.onWatch(other, { kind: 'watch', watcher: 'actor-ts://rw/user/other', watchee });
    subject.tell('stop');
    await awaitCondition(() => r.sent.length >= 1, { timeoutMs: 4_000, label: 'the surviving watch was answered' });
    expect(r.sent.map((s) => s.to)).toEqual([other]);
  });

  test('shutdown withdraws every planted proxy and stops listening to membership', async () => {
    const r = rig();
    let instance: Recorder | null = null;
    const watcher = r.system.spawn(() => (instance = new Recorder()), 'watcher');
    const subject = r.system.spawn(Subject, 'subject');
    r.watcher.onWatch(PEER, { kind: 'watch', watcher: 'actor-ts://rw/user/far', watchee: subject.path.toString() });
    r.watcher.watch(watcher, remote(r, 'actor-ts://rw/user/x'));
    r.sent.length = 0;
    r.watcher.shutdown();
    r.emit(new MemberRemoved(member(PEER)));
    subject.tell('stop');
    await awaitCondition(() => instance !== null, { timeoutMs: 4_000, label: 'the recorder exists' });
    // Ordered against the subject's own stop: once it is gone nothing else
    // will be sent, and the watcher was never told about the removed node.
    await awaitCondition(() => r.system._resolvePath(['user', 'subject']).isNone(), { timeoutMs: 4_000, label: 'the subject stopped' });
    expect(r.sent).toHaveLength(0);
    expect(instance!.terminations).toHaveLength(0);
  });
});
