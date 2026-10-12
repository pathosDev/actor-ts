/**
 * #1431 — an actor that declares control messages gets a queue that can serve
 * them, without being asked to spawn itself differently.
 *
 * The capability is a mailbox type, `ControlAwareMailbox`: control messages
 * are handed over ahead of everything ordinary already queued, and a bound
 * never sheds them.  An application opts into it with `withMailbox`.  An
 * actor whose control traffic is part of its *contract* cannot wait for every
 * spawn site to opt in — the WebSocket hub is spawned by the application, in
 * the class form or through a factory, and the framework only ever sees its
 * ref — so the actor says it instead, through the internal
 * `Actor._controlMessages()` hook, and the cell acts on the answer.
 *
 * The cell has to act late.  It builds its queue in its constructor, before
 * the instance exists, because `tell` works the moment `spawn` returns; so the
 * first start — the instance just built, its first message not yet handed
 * over — is where the queue is swapped, once, envelopes and all.  This file
 * pins that swap on a plain `Actor` subclass:
 *
 *   - it happens once, at the first start, and keeps what was told before it;
 *   - it keeps the bound the queue it replaces had, and the cell still hears
 *     about every drop;
 *   - it loses nothing the old queue admitted, carries a suspension over, and
 *     moves the system commands queued behind the `create` too;
 *   - a restart keeps the swapped queue and asks nothing again;
 *   - a caller's own `withMailbox` is never swapped, and an actor that
 *     declares nothing keeps the queue it was built with.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorOptions } from '../../../../src/ActorOptions.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { LocalActorRef } from '../../../../src/internal/LocalActorRef.js';
import { Mailbox } from '../../../../src/internal/Mailbox.js';
import { BoundedMailbox } from '../../../../src/mailbox/BoundedMailbox.js';
import { ControlAwareMailbox } from '../../../../src/mailbox/ControlAwareMailbox.js';
import type { MetricsRegistry } from '../../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../../src/metrics/MetricsExtension.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* ------------------------- a generic declaring actor ------------------------- */

type OrdinaryMessage = { readonly kind: 'ordinary'; readonly n: number };
type UrgentMessage = { readonly kind: 'urgent'; readonly n: number };
/** Parks the actor inside its handler until the test opens the gate. */
type GateMessage = { readonly kind: 'gate' };
/** Fails the handler, so the supervisor restarts the actor. */
type FailMessage = { readonly kind: 'fail' };
type TestMessage = OrdinaryMessage | UrgentMessage | GateMessage | FailMessage;

const ordinary = (n: number): OrdinaryMessage => ({ kind: 'ordinary', n });
const urgent = (n: number): UrgentMessage => ({ kind: 'urgent', n });
const gate: GateMessage = { kind: 'gate' };
const fail: FailMessage = { kind: 'fail' };

/** The control predicate a declaring actor hands the cell — module-level, as the hook asks. */
function isUrgent(message: unknown): boolean {
  return (message as { kind?: unknown } | null)?.kind === 'urgent';
}

/** What the actor did, owned by the test. */
type ActorRecord = {
  starts: number;
  /** How often the cell asked the hook. */
  declarations: number;
  /** Set once the actor is parked inside the gate handler. */
  parked: boolean;
  readonly handled: string[];
  readonly gate: Promise<void>;
};

class PlainActor extends Actor<TestMessage> {
  constructor(protected readonly record: ActorRecord) {
    super();
  }

  override preStart(): void {
    this.record.starts += 1;
  }

  override onReceive(message: TestMessage): void | Promise<void> {
    return match(message)
      .with({ kind: 'ordinary' }, (m) => this.onOrdinary(m))
      .with({ kind: 'urgent' }, (m) => this.onUrgent(m))
      .with({ kind: 'gate' }, () => this.onGate())
      .with({ kind: 'fail' }, () => this.onFail())
      .exhaustive();
  }

  private onOrdinary(message: OrdinaryMessage): void {
    this.record.handled.push(`ordinary:${message.n}`);
  }

  private onUrgent(message: UrgentMessage): void {
    this.record.handled.push(`urgent:${message.n}`);
  }

  private async onGate(): Promise<void> {
    this.record.parked = true;
    await this.record.gate;
    this.record.parked = false;
  }

  private onFail(): void {
    throw new Error('asked to fail');
  }
}

/** The same actor, declaring `urgent` as its control messages. */
class DeclaringActor extends PlainActor {
  override _controlMessages(): (message: unknown) => boolean {
    this.record.declarations += 1;
    return isUrgent;
  }
}

const systems: ActorSystem[] = [];
const openGates: Array<() => void> = [];
afterEach(async () => {
  // Open every gate first: a parked actor holds `terminate()` open.
  for (const open of openGates.splice(0)) open();
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function newSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

function newRecord(): { record: ActorRecord; openGate: () => void } {
  let openGate = (): void => { /* replaced below */ };
  const opened = new Promise<void>((resolve) => { openGate = () => resolve(); });
  openGates.push(openGate);
  return { record: { starts: 0, declarations: 0, parked: false, handled: [], gate: opened }, openGate };
}

async function parked(record: ActorRecord): Promise<void> {
  await awaitCondition(() => record.parked, { timeoutMs: 4_000, label: 'the actor parked inside its handler' });
}

async function handledCount(record: ActorRecord, count: number): Promise<void> {
  await awaitCondition(() => record.handled.length >= count, {
    timeoutMs: 4_000,
    label: `the actor handled ${count} messages`,
  });
}

/** `actor_mailbox_dropped_total` for one class and reason. */
function droppedFor(registry: MetricsRegistry, className: string, reason: string): number {
  return registry.collect()
    .filter((sample) => sample.name === 'actor_mailbox_dropped_total'
      && sample.labels['class'] === className && sample.labels['reason'] === reason)
    .reduce((total, sample) => total + sample.value, 0);
}

describe('an actor that declares control messages gets a control-aware queue (#1431)', () => {
  test('the framework-built queue is replaced once, at first start, keeping what was told before it', async () => {
    const system = newSystem('control-lane-first-start');
    const { record } = newRecord();
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring') as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    const built = cell._mailboxForTest();
    // Before the first start the queue is what the spawn options built.
    expect(built).not.toBeInstanceOf(ControlAwareMailbox);

    // All four reach the queue before the actor exists.
    ref.tell(ordinary(1));
    ref.tell(ordinary(2));
    ref.tell(urgent(1));
    ref.tell(ordinary(3));
    await handledCount(record, 4);

    // Nothing lost, ordinary order kept, and the control message first — it
    // was classified when it moved across, like any arrival.
    expect(record.handled).toEqual(['urgent:1', 'ordinary:1', 'ordinary:2', 'ordinary:3']);
    expect(cell._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);
    expect(record.declarations).toBe(1);
  });

  test('a restart keeps the replaced queue, and the hook is not asked again', async () => {
    const system = newSystem('control-lane-restart');
    const { record, openGate } = newRecord();
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring') as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    await awaitCondition(() => record.starts === 1, { timeoutMs: 4_000, label: 'the actor started' });
    const adopted = cell._mailboxForTest();
    expect(adopted).toBeInstanceOf(ControlAwareMailbox);

    ref.tell(fail);
    await awaitCondition(() => record.starts === 2, { timeoutMs: 4_000, label: 'the actor restarted' });
    expect(cell._mailboxForTest()).toBe(adopted);
    expect(record.declarations).toBe(1);

    // And it still serves the new incarnation: urgent overtakes the backlog.
    ref.tell(gate);
    await parked(record);
    ref.tell(ordinary(10));
    ref.tell(urgent(10));
    openGate();
    await handledCount(record, 2);
    expect(record.handled).toEqual(['urgent:10', 'ordinary:10']);
  });

  test('the bound of the replaced queue is kept, and its drops still reach the cell', async () => {
    const system = newSystem('control-lane-bound');
    const registry = system.extension(MetricsExtensionId).enable();
    const { record, openGate } = newRecord();
    const options = ActorOptions.create<TestMessage>()
      .withMailboxCapacity(2)
      .withMailboxOverflow('drop-new');
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    expect(cell._mailboxForTest()).toBeInstanceOf(BoundedMailbox);

    ref.tell(gate);
    await parked(record);
    for (let n = 1; n <= 5; n++) ref.tell(ordinary(n));
    ref.tell(urgent(1));
    openGate();
    await handledCount(record, 3);

    // Two ordinary messages fit the bound and three were shed; the control
    // message was admitted past it and overtook both survivors.
    expect(record.handled).toEqual(['urgent:1', 'ordinary:1', 'ordinary:2']);
    expect(cell._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);
    expect(droppedFor(registry, 'DeclaringActor', 'drop-new')).toBe(3);
  });

  test('nothing the old queue admitted is shed on the way across', async () => {
    const system = newSystem('control-lane-transfer');
    const { record } = newRecord();
    const options = ActorOptions.create<TestMessage>()
      .withMailboxCapacity(2)
      .withMailboxOverflow('drop-head');
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();

    // Before the first start: the bound fills, two envelopes take the exempt
    // door past it, and the next arrival evicts the oldest droppable one.  The
    // old queue now holds more than its capacity in front of its last arrival
    // — which a transfer that re-applied the bound would evict again.
    ref.tell(ordinary(1));
    ref.tell(ordinary(2));
    cell.postSignalEnvelope({ message: ordinary(101), sender: null });
    cell.postSignalEnvelope({ message: ordinary(102), sender: null });
    ref.tell(ordinary(3));
    await handledCount(record, 4);

    expect(record.handled).toEqual(['ordinary:2', 'ordinary:101', 'ordinary:102', 'ordinary:3']);
  });

  test('a suspension and the system commands queued behind the create move across too', async () => {
    const system = newSystem('control-lane-system-lane');
    const { record } = newRecord();
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring') as LocalActorRef<TestMessage>;
    const cell = ref.getCell();

    cell._mailboxForTest().suspend();
    ref.tell(ordinary(1));
    await awaitCondition(() => record.starts === 1, { timeoutMs: 4_000, label: 'the actor started' });
    expect(cell._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);
    expect(cell._mailboxForTest().suspended).toBe(true);
    expect(record.handled).toEqual([]);

    cell.enqueueSystem({ kind: 'resume' });
    await handledCount(record, 1);
    expect(record.handled).toEqual(['ordinary:1']);

    // A stop queued on the system lane before the first start is not lost.
    const second = newRecord();
    const stopped = system.spawn(() => new DeclaringActor(second.record), 'stopped') as LocalActorRef<TestMessage>;
    stopped.getCell().enqueueSystem({ kind: 'terminate' });
    await awaitCondition(() => stopped.getCell().isTerminated(), {
      timeoutMs: 4_000,
      label: 'the terminate queued before the first start was handled',
    });
  });

  test("a caller's own withMailbox is never replaced, and keeps arrival order", async () => {
    const system = newSystem('control-lane-caller-mailbox');
    const { record, openGate } = newRecord();
    let supplied: Mailbox<TestMessage> | null = null;
    const options = ActorOptions.create<TestMessage>().withMailbox(() => {
      supplied = new Mailbox<TestMessage>();
      return supplied;
    });
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();

    ref.tell(gate);
    await parked(record);
    ref.tell(ordinary(1));
    ref.tell(urgent(1));
    openGate();
    await handledCount(record, 2);

    expect(supplied).not.toBeNull();
    expect(cell._mailboxForTest()).toBe(supplied!);
    expect(record.handled).toEqual(['ordinary:1', 'urgent:1']);
  });

  test('an actor that declares nothing keeps the queue it was built with', async () => {
    const system = newSystem('control-lane-plain');
    const { record, openGate } = newRecord();
    const options = ActorOptions.create<TestMessage>().withMailboxCapacity(4);
    const ref = system.spawn(() => new PlainActor(record), 'plain', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    const built = cell._mailboxForTest();

    ref.tell(gate);
    await parked(record);
    ref.tell(ordinary(1));
    ref.tell(urgent(1));
    openGate();
    await handledCount(record, 2);

    expect(cell._mailboxForTest()).toBe(built);
    expect(built).toBeInstanceOf(BoundedMailbox);
    expect(record.handled).toEqual(['ordinary:1', 'urgent:1']);
  });
});
