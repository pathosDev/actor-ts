/**
 * What a `ClusterClient` is allowed to learn from a failed request (#130).
 *
 * The receptionist is the one wire path where a party that never joined the
 * membership ring addresses arbitrary actors by path, so everything it puts
 * into a `cluster-client-reply` crosses a trust boundary.  These tests pin
 * the two directions that matters in: the client gets a reason it can act on
 * and nothing more, and the operator keeps the reason it needs.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import {
  ClusterClientReceptionistId,
  type ClusterClientEnvelopeMessage,
  type ClusterClientReplyMessage,
} from '../../../src/cluster/ClusterClientReceptionist.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/* ----------------------------- test doubles ---------------------------- */

type LogRecord = { readonly level: string; readonly message: string; readonly args: unknown[] };

/** Collects everything the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string, args: unknown[]): void {
    this.sink.records.push({ level, message, args });
  }

  debug(message: string, ...args: unknown[]): void { this.record('debug', message, args); }
  info(message: string, ...args: unknown[]): void { this.record('info', message, args); }
  warn(message: string, ...args: unknown[]): void { this.record('warn', message, args); }
  error(message: string, ...args: unknown[]): void { this.record('error', message, args); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/**
 * The receptionist touches exactly three things on a `Cluster` — its own
 * address, the wire-handler registry and `transport.send` — so the whole
 * envelope path is drivable without a socket.
 */
class FakeCluster {
  readonly sent: Array<{ to: NodeAddress; reply: ClusterClientReplyMessage }> = [];
  private handler: ((message: WireMessage, from: NodeAddress) => void) | null = null;

  readonly transport = {
    send: (to: NodeAddress, message: WireMessage): void => {
      this.sent.push({ to, reply: message as unknown as ClusterClientReplyMessage });
    },
  };

  constructor(readonly selfAddress: NodeAddress) {}

  _onWire(_kind: string, handler: (message: WireMessage, from: NodeAddress) => void): () => void {
    this.handler = handler;
    return (): void => { this.handler = null; };
  }

  /** Feed one envelope in as if it had arrived from `from`'s connection. */
  deliver(envelope: ClusterClientEnvelopeMessage, from: NodeAddress): void {
    if (!this.handler) throw new Error('no wire handler registered');
    this.handler(envelope as unknown as WireMessage, from);
  }
}

/* -------------------------------- fixture ------------------------------ */

/** Everything a leaking failure could plausibly drag onto the wire. */
const SECRETS = [
  '/srv/app/config/credentials.json',
  'postgres://svc:hunter2@db.internal:5432/orders',
  'at OrderActor.onReceive (/srv/app/dist/OrderActor.js:41:15)',
];

class Exploding extends Actor<unknown> {
  override onReceive(): void {
    const err = new Error(`ENOENT: no such file or directory, open '${SECRETS[0]}' — ${SECRETS[1]}`);
    err.stack = `Error: boom\n    ${SECRETS[2]}`;
    this.sender.forEach((s) => s.tell(err));
  }
}

class Echo extends Actor<{ hello?: boolean }> {
  override onReceive(message: { hello?: boolean }): void {
    // Only the caller's own field — `ask` injects a `replyTo` ref alongside it.
    this.sender.forEach((s) => s.tell({ echoed: message.hello }));
  }
}

const CLIENT = new NodeAddress('cluster-client', '203.0.113.9', 51_000);

type Fixture = {
  readonly system: ActorSystem;
  readonly cluster: FakeCluster;
  readonly log: RecordingLogger;
};

function startFixture(name: string): Fixture {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(name, systemOptions);
  system.spawn(Exploding, 'exploding');
  system.spawn(Echo, 'echo');
  const cluster = new FakeCluster(new NodeAddress(name, '10.0.0.5', 2_552));
  system.extension(ClusterClientReceptionistId).start(cluster as unknown as Cluster);
  return { system, cluster, log };
}

const replyBody = (fixture: Fixture): string => String(fixture.cluster.sent[0]!.reply.body);

const awaitReply = (fixture: Fixture): Promise<void> =>
  awaitCondition(() => fixture.cluster.sent.length > 0, {
    label: 'the receptionist sent a cluster-client-reply',
  });

/* --------------------------------- tests ------------------------------- */

describe('ClusterClientReceptionist — what a failed ask tells the client', () => {
  test('the reply carries none of the rejection text', async () => {
    const fixture = startFixture('receptionist-redaction');
    const envelope: ClusterClientEnvelopeMessage = {
      kind: 'cluster-client-envelope',
      from: CLIENT.toJSON(),
      to: 'exploding',
      askId: 'ask-1',
      body: { kind: 'place-order' },
    };
    fixture.cluster.deliver(envelope, CLIENT);
    await awaitReply(fixture);

    const { reply } = fixture.cluster.sent[0]!;
    expect(reply.kind).toBe('cluster-client-reply');
    expect(reply.askId).toBe('ask-1');
    expect(reply.ok).toBe(false);
    for (const secret of SECRETS) expect(replyBody(fixture)).not.toContain(secret);
    expect(replyBody(fixture)).not.toContain('ENOENT');
    await fixture.system.terminate();
  });

  test('the reply carries a correlation id, and the node logs the reason under it', async () => {
    const fixture = startFixture('receptionist-correlation');
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      from: CLIENT.toJSON(),
      to: 'exploding',
      askId: 'ask-2',
      body: {},
    }, CLIENT);
    await awaitReply(fixture);

    const correlationId = /correlationId=([0-9a-f-]{36})/.exec(replyBody(fixture))?.[1];
    expect(correlationId).toBeDefined();

    // The operator's half of the bargain: the id is greppable in the node's
    // log, and the untruncated error object rode along so a sink that
    // formats stacks still has one.
    const warning = fixture.log.records.find(
      (r) => r.level === 'warn' && r.message.includes(correlationId!),
    );
    expect(warning).toBeDefined();
    expect((warning!.args[0] as Error).message).toContain(SECRETS[0]!);
    await fixture.system.terminate();
  });

  test('two failures get two different correlation ids', async () => {
    const fixture = startFixture('receptionist-distinct-ids');
    for (const askId of ['ask-3', 'ask-4']) {
      fixture.cluster.deliver({
        kind: 'cluster-client-envelope',
        from: CLIENT.toJSON(),
        to: 'exploding',
        askId,
        body: {},
      }, CLIENT);
    }
    await awaitCondition(() => fixture.cluster.sent.length === 2, {
      label: 'both failed asks were answered',
    });
    const ids = fixture.cluster.sent.map(
      (s) => /correlationId=([0-9a-f-]{36})/.exec(String(s.reply.body))?.[1],
    );
    expect(ids[0]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
    await fixture.system.terminate();
  });

  test('a successful ask still replies with the actor’s own value', async () => {
    const fixture = startFixture('receptionist-happy-path');
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      from: CLIENT.toJSON(),
      to: 'echo',
      askId: 'ask-5',
      body: { hello: true },
    }, CLIENT);
    await awaitReply(fixture);

    const { reply } = fixture.cluster.sent[0]!;
    expect(reply.ok).toBe(true);
    expect(reply.body).toEqual({ echoed: true });
    await fixture.system.terminate();
  });

  test('the reply goes to the connection the envelope arrived on', async () => {
    const fixture = startFixture('receptionist-reply-target');
    const forged = new NodeAddress('victim', '198.51.100.7', 2_552);
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      from: forged.toJSON(),
      to: 'exploding',
      askId: 'ask-6',
      body: {},
    }, CLIENT);
    await awaitReply(fixture);

    expect(fixture.cluster.sent[0]!.to.toString()).toBe(CLIENT.toString());
    await fixture.system.terminate();
  });
});

describe('ClusterClientReceptionist — what an unknown path tells the client', () => {
  test('names the path the client asked for, not the node it reached', async () => {
    const fixture = startFixture('receptionist-unknown-path');
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      from: CLIENT.toJSON(),
      to: 'not/a/real/path',
      askId: 'ask-7',
      body: {},
    }, CLIENT);
    await awaitReply(fixture);

    const body = replyBody(fixture);
    expect(fixture.cluster.sent[0]!.reply.ok).toBe(false);
    expect(body).toContain('path not found');
    expect(body).toContain('not/a/real/path');
    // A contact point is reachable from outside whatever boundary protects
    // the cluster's own links, and the address it binds on is not
    // necessarily the one the client dialled.
    expect(body).not.toContain('10.0.0.5');
    expect(body).not.toContain(fixture.cluster.selfAddress.toString());
    await fixture.system.terminate();
  });

  test('an unknown path with no askId is dropped, not answered', async () => {
    const fixture = startFixture('receptionist-unknown-tell');
    fixture.cluster.deliver({
      kind: 'cluster-client-envelope',
      from: CLIENT.toJSON(),
      to: 'not/a/real/path',
      body: {},
    }, CLIENT);
    await awaitCondition(
      () => fixture.log.records.some((r) => r.message.includes('dropped')),
      { label: 'the tell to an unknown path was logged as dropped' },
    );
    expect(fixture.cluster.sent).toHaveLength(0);
    await fixture.system.terminate();
  });
});
