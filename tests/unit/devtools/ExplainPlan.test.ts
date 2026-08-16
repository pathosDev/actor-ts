import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { ActorContext } from '../../../src/ActorContext.js';
import type { MessageExplain } from '../../../src/internal/Instrumentation.js';

type Probe = {
  readonly plan: () => ReadonlyArray<MessageExplain>;
  readonly context: () => ActorContext<string>;
};

/** An actor that records its own plan and exposes it to the test. */
class RecordedActor extends Actor<string> {
  constructor(
    private readonly capacity: number | undefined,
    private readonly register: (probe: Probe) => void,
  ) {
    super();
  }

  override preStart(): void {
    this.context.enableExplainPlan(
      this.capacity === undefined ? {} : { capacity: this.capacity },
    );
    this.register({
      plan: () => this.context.explainPlan(),
      context: () => this.context,
    });
  }

  private accepting = false;

  override async onReceive(message: string): Promise<void> {
    if (message === 'boom') throw new Error('handler exploded');
    // Stash until told to accept; a replayed message that stashed again
    // would never show up as a completed handling.
    if (message === 'stash-me' && !this.accepting) { this.context.stash(); return; }
    if (message === 'unstash') { this.accepting = true; this.context.unstashAll(); return; }
    if (message === 'slow') await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

/**
 * Spawn the actor and wait until `preStart` has enabled its plan.
 *
 * The wait matters: a message enqueued before the plan exists carries
 * no timestamp, so its mailbox wait is (correctly) `null`.
 */
async function spawnRecorded(
  name: string,
  capacity?: number,
): Promise<{ probe: Probe; ref: ReturnType<ActorSystem['spawn']> }> {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  let registered: Probe | null = null;
  const ref = system.spawn(
    () => new RecordedActor(capacity, (p) => { registered = p; }),
    'recorded',
  );
  while (registered === null) await new Promise((resolve) => setTimeout(resolve, 5));
  return { probe: registered, ref };
}

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('explain plan — recording', () => {
  test('records one entry per handled message, oldest first', async () => {
    const { probe, ref } = await spawnRecorded('explain-basic');
    ref.tell('a');
    ref.tell('b');
    await settle();

    const plan = probe.plan();
    expect(plan.map((entry) => entry.messageType)).toEqual(['String', 'String']);
    expect(plan.map((entry) => entry.sequenceNumber)).toEqual([1, 2]);
  });

  test('captures handling time', async () => {
    const { probe, ref } = await spawnRecorded('explain-timing');
    ref.tell('slow');
    await settle(120);
    expect(probe.plan()[0]!.handleTimeMs).toBeGreaterThan(30);
  });

  test('captures mailbox wait, including time spent queued behind others', async () => {
    const { probe, ref } = await spawnRecorded('explain-wait');
    // The second message waits for the first (40 ms) to finish.
    ref.tell('slow');
    ref.tell('quick');
    await settle(150);

    const plan = probe.plan();
    expect(plan).toHaveLength(2);
    expect(plan[1]!.mailboxWaitMs).not.toBeNull();
    expect(plan[1]!.mailboxWaitMs!).toBeGreaterThan(30);
  });

  test('a recorder switched on mid-handling still gets a real atMs (#411)', async () => {
    // `Date.now()` used to be read for every message, on the way in, and was
    // only ever used by this recorder.  #411 moved it behind the `_explain`
    // null check in the `finally`, deriving the start from the end and the
    // measured duration — and this is the case that had to survive the move.
    //
    // A start stamp taken at the top would have been *skipped* for a message
    // dispatched while the recorder was still off, so a recorder enabled from
    // inside the handler would have recorded `atMs: 0` — an entry stamped at
    // the epoch, which is worse than no entry at all.
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('explain-midflight', options);
    systems.push(system);

    let probe: Probe | null = null;
    class LateRecorder extends Actor<string> {
      override async onReceive(message: string): Promise<void> {
        if (message === 'enable-now') {
          // Switched on *during* the handling of this very message.
          this.context.enableExplainPlan({});
          probe = {
            plan: () => this.context.explainPlan(),
            context: () => this.context,
          };
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }

    const before = Date.now();
    const ref = system.spawn(LateRecorder, 'late');
    ref.tell('enable-now');
    await settle(120);

    const plan = probe!.plan();
    expect(plan).toHaveLength(1);
    // A real wall-clock stamp bracketed by the test, not the epoch.
    expect(plan[0]!.atMs).toBeGreaterThanOrEqual(before);
    expect(plan[0]!.atMs).toBeLessThanOrEqual(Date.now());
    // And it really is the *start*: the handler slept 20 ms, so the derived
    // start sits that far behind the moment the entry was written.
    expect(plan[0]!.handleTimeMs).toBeGreaterThan(15);
    expect(Date.now() - plan[0]!.atMs).toBeGreaterThanOrEqual(15);
    // The message was enqueued before the recorder existed, so it carries no
    // enqueue stamp and its wait is correctly unknown rather than invented.
    expect(plan[0]!.mailboxWaitMs).toBeNull();
  });

  test('records the sender when there is one', async () => {
    const { probe, ref } = await spawnRecorded('explain-sender');
    const system = systems[systems.length - 1]!;
    class SenderActor extends Actor<string> {
      override preStart(): void { ref.tell('hello', this.context.self); }
      override onReceive(): void {}
    }
    system.spawn(SenderActor, 'sender');
    await settle();

    expect(probe.plan()[0]!.senderPath).toContain('/user/sender');
  });

  test('marks a throwing handler as an error and keeps the message', async () => {
    const { probe, ref } = await spawnRecorded('explain-error');
    ref.tell('boom');
    await settle();

    const entry = probe.plan().find((e) => e.outcome === 'error');
    expect(entry).toBeDefined();
    expect(entry!.errorMessage).toContain('handler exploded');
  });

  test('distinguishes a stashed message from one that simply returned', async () => {
    const { probe, ref } = await spawnRecorded('explain-stash');
    ref.tell('stash-me');
    await settle();

    const plan = probe.plan();
    expect(plan[0]!.outcome).toBe('stashed');
  });

  test('a replayed stashed message keeps its original wait, so stash time counts', async () => {
    const { probe, ref } = await spawnRecorded('explain-stash-wait');
    ref.tell('stash-me');
    await settle(60);
    ref.tell('unstash');
    await settle(60);

    const plan = probe.plan();
    // Three handlings: stash-me (stashed), unstash (ok), stash-me again
    // (ok, replayed).  The replay carries the ORIGINAL enqueue stamp, so
    // its wait spans the whole stash residency rather than restarting.
    //
    // Since #196 this is also the guard that the enqueue funnel does not
    // *restamp* a replay.  The stamp is now taken whenever metrics are on
    // as well as under a plan, and `_enqueueUser` is the one place that
    // takes it — so a future change routing `unstashAll` through the funnel
    // would silently reset this wait to ~0 and nothing else would notice.
    // The metric reads the same field and deliberately draws the opposite
    // conclusion from it: `actor_mailbox_wait_seconds` skips replays,
    // because an aggregate with no outcome column cannot show the reader
    // the `stashed` entry that explains a 50 ms wait.  Both behaviours are
    // intended; see `Envelope.replayed`.
    expect(plan.map((entry) => entry.outcome)).toEqual(['stashed', 'ok', 'ok']);
    expect(plan[2]!.mailboxWaitMs).not.toBeNull();
    expect(plan[2]!.mailboxWaitMs!).toBeGreaterThan(50);
    // …and the message that arrived after it waited barely at all.
    expect(plan[1]!.mailboxWaitMs!).toBeLessThan(50);
  });
});

describe('explain plan — lifecycle', () => {
  test('evicts the oldest once the ring is full', async () => {
    const { probe, ref } = await spawnRecorded('explain-ring', 3);
    for (let i = 0; i < 8; i++) ref.tell(`m${i}`);
    await settle();

    const plan = probe.plan();
    expect(plan).toHaveLength(3);
    // Sequence numbers keep counting, so a gap is visible.
    expect(plan.map((entry) => entry.sequenceNumber)).toEqual([6, 7, 8]);
  });

  test('records nothing while disabled', async () => {
    const { probe, ref } = await spawnRecorded('explain-disabled');
    probe.context().disableExplainPlan();
    ref.tell('ignored');
    await settle();
    expect(probe.plan()).toEqual([]);
  });

  test('re-enabling starts a fresh ring', async () => {
    const { probe, ref } = await spawnRecorded('explain-reenable');
    ref.tell('first');
    await settle();
    expect(probe.plan().length).toBeGreaterThan(0);

    probe.context().disableExplainPlan();
    probe.context().enableExplainPlan({ capacity: 5 });
    expect(probe.plan()).toEqual([]);

    ref.tell('second');
    await settle();
    expect(probe.plan()).toHaveLength(1);
  });

  test('an actor without a plan reports nothing and is never stamped', async () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('explain-off', options);
    systems.push(system);

    let seen: ReadonlyArray<MessageExplain> = [{ sequenceNumber: -1 } as MessageExplain];
    class PlainActor extends Actor<string> {
      override onReceive(): void { seen = this.context.explainPlan(); }
    }
    const ref = system.spawn(PlainActor, 'plain');
    ref.tell('x');
    await settle();
    expect(seen).toEqual([]);
  });
});
