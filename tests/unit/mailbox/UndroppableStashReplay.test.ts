/**
 * Which stash replay preserves `Envelope.undroppable`, and which does not
 * (#729, #1319).
 *
 * #729 gave the marker a claim it does not earn everywhere: that it "survives a
 * `stash` / `unstashAll` round trip", stated without qualification in the
 * `Envelope.undroppable` JSDoc and in the mailboxes page in both languages.  It
 * holds for the untyped stash and fails for the typed one, and nothing here
 * executed either statement — the round trip was read off the call chain rather
 * than run.
 *
 * The two paths differ in *what they park*.  `ActorContext.stash()` parks the
 * envelope the cell is currently handling, so `unstashAll()` hands the mailbox
 * the same object it received, marker included.  `Behaviors.withStash` cannot:
 * `StashBuffer.stash(message)` takes an arbitrary value, so the buffer holds
 * bare messages and the replay half — `ActorCell.prependUserMessages` — has to
 * *rebuild* envelopes as message-plus-null-sender.  Everything the envelope
 * carried is gone by the time the queue sees it, `undroppable` with it, and a
 * bound then gets the second chance the marker exists to deny it.
 *
 * That gap is #1319 and is deliberately not closed here.  What these tests pin
 * is the pair of facts the qualified claim rests on, executed rather than
 * asserted, plus the prose that has to keep saying which is which.  Fixing
 * #1319 turns the second one red — correctly: the qualification comes out in
 * the same change.
 *
 * The observation seam is the mailbox's own replay door.  A recording subclass
 * captures whatever `prependUser` is handed, which is deterministic and needs
 * no parking: the cell drains the moment a handler returns, so reading the
 * queue afterwards would race the drain, and reading it under a bound would
 * make the assertion depend on where a batch happened to fall against a
 * capacity.  What the replay *hands the queue* is the whole question.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Terminated } from '../../../src/SystemMessages.js';
import { Mailbox, type Envelope } from '../../../src/mailbox/index.js';
import {
  Behaviors,
  typedActor,
  type Behavior,
  type StashBuffer,
  type TypedActorContext,
} from '../../../src/typed/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const newSystem = (name: string): ActorSystem => {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
};

/* ----------------------------- test protocol ------------------------------ */

type DieMessage = { readonly kind: 'die' };
type TargetMessage = DieMessage;

type WatchMessage = { readonly kind: 'watch'; readonly target: ActorRef<TargetMessage> };
type ReplayMessage = { readonly kind: 'replay' };
type WatcherMessage = WatchMessage | ReplayMessage | Terminated;

/** What one test observes about its watcher, reset per test. */
type WatcherProbe = {
  readonly watched: { value: boolean };
  readonly stashed: { value: boolean };
  readonly replayed: { value: boolean };
};

const newProbe = (): WatcherProbe => ({
  watched: { value: false },
  stashed: { value: false },
  replayed: { value: false },
});

let probe: WatcherProbe = newProbe();

/**
 * A queue that keeps a copy of every envelope the replay door hands it.
 *
 * Unbounded on purpose: the bound is what #729 was about, and it is not what
 * this file is asking.  The question here is what the envelope still carries
 * when it arrives, which is upstream of any policy having an opinion.
 */
class ReplayRecordingMailbox<T> extends Mailbox<T> {
  readonly replayedEnvelopes: Array<Envelope<T>> = [];

  override prependUser(envs: Array<Envelope<T>>): void {
    this.replayedEnvelopes.push(...envs);
    super.prependUser(envs);
  }
}

class DyingTarget extends Actor<TargetMessage> {
  override onReceive(m: TargetMessage): void {
    match(m)
      .with({ kind: 'die' }, () => this.onDie())
      .exhaustive();
  }

  private onDie(): void {
    this.self.stop();
  }
}

/** Parks the death notification with `ActorContext.stash()` — the untyped door. */
class UntypedStashingWatcher extends Actor<WatcherMessage> {
  override onReceive(m: WatcherMessage): void {
    match(m)
      .with(P.instanceOf(Terminated), () => this.onTerminated())
      .with({ kind: 'watch' }, (message) => this.onWatch(message))
      .with({ kind: 'replay' }, () => this.onReplay())
      .exhaustive();
  }

  private onTerminated(): void {
    // Once only: the replayed notification is consumed rather than redelivered
    // (the cell retires the watch registration first), but a future change to
    // that would otherwise turn this actor into a stash loop.
    if (probe.stashed.value) return;
    this.context.stash();
    probe.stashed.value = true;
  }

  private onWatch(message: WatchMessage): void {
    this.context.watch(message.target);
    probe.watched.value = true;
  }

  private onReplay(): void {
    this.context.unstashAll();
    probe.replayed.value = true;
  }
}

/* ------------------------- the typed half, as a behavior ------------------- */

const onTypedTerminated = (stash: StashBuffer<WatcherMessage>, signal: Terminated): Behavior<WatcherMessage> => {
  if (probe.stashed.value) return Behaviors.same;
  stash.stash(signal);
  probe.stashed.value = true;
  return Behaviors.same;
};

const onTypedWatch = (
  context: TypedActorContext<WatcherMessage>,
  message: WatchMessage,
): Behavior<WatcherMessage> => {
  context.watch(message.target);
  probe.watched.value = true;
  return Behaviors.same;
};

const onTypedReplay = (stash: StashBuffer<WatcherMessage>): Behavior<WatcherMessage> => {
  stash.unstashAll();
  probe.replayed.value = true;
  return Behaviors.same;
};

/**
 * The typed mirror of {@link UntypedStashingWatcher}.
 *
 * No `onSignal`: `TypedActor` routes a `Terminated` to the signal handler only
 * when one is installed, and this behavior wants the notification as a
 * *message* — which is what makes it stashable through `StashBuffer` at all.
 */
const typedStashingWatcher = (): Behavior<WatcherMessage> =>
  Behaviors.withStash<WatcherMessage>(4, (stash) =>
    Behaviors.receive<WatcherMessage>((context, message) =>
      match(message)
        .with(P.instanceOf(Terminated), (signal) => onTypedTerminated(stash, signal))
        .with({ kind: 'watch' }, (m) => onTypedWatch(context, m))
        .with({ kind: 'replay' }, () => onTypedReplay(stash))
        .exhaustive(),
    ),
  );

/* -------------------------------- helpers --------------------------------- */

/**
 * Watch, let the target die, park the notification, then replay it.
 *
 * Returns once `unstashAll()` has run, so the recording below reads a completed
 * replay rather than an empty one.
 */
const stashAndReplayADeath = async (
  system: ActorSystem,
  watcher: ActorRef<WatcherMessage>,
): Promise<void> => {
  const target = system.spawn(DyingTarget, 'target');
  watcher.tell({ kind: 'watch', target });
  await awaitCondition(() => probe.watched.value, {
    timeoutMs: 4_000,
    label: 'the watcher registered its death watch',
  });

  target.tell({ kind: 'die' });
  await awaitCondition(() => probe.stashed.value, {
    timeoutMs: 4_000,
    label: 'the watcher stashed the Terminated',
  });

  watcher.tell({ kind: 'replay' });
  await awaitCondition(() => probe.replayed.value, {
    timeoutMs: 4_000,
    label: 'the watcher replayed its stash',
  });
};

/* --------------------------- the executed halves --------------------------- */

describe('the undroppable marker across the two stash replays — #729, #1319', () => {
  test('the untyped stash replay hands the queue the marked envelope', async () => {
    probe = newProbe();
    const system = newSystem('729-untyped-stash-replay');
    const mailbox = new ReplayRecordingMailbox<WatcherMessage>();
    const watcherOptions = ActorOptions.create<WatcherMessage>().withMailbox(() => mailbox);
    const watcher = system.spawn(UntypedStashingWatcher, 'watcher', watcherOptions);

    await stashAndReplayADeath(system, watcher);

    // `ActorContext.stash()` parked the envelope itself, so the replay is the
    // same object the exempt door built — marker intact, and therefore still
    // out of reach of every load-shedding policy on the way back in.
    expect(mailbox.replayedEnvelopes.length).toBe(1);
    const replayed = mailbox.replayedEnvelopes[0]!;
    expect(replayed.message).toBeInstanceOf(Terminated);
    expect(replayed.undroppable).toBe(true);

    await system.terminate();
  });

  test('the typed stash replay rebuilds the envelope and loses the marker — #1319', async () => {
    probe = newProbe();
    const system = newSystem('1319-typed-stash-replay');
    const mailbox = new ReplayRecordingMailbox<WatcherMessage>();
    const watcherOptions = ActorOptions.create<WatcherMessage>().withMailbox(() => mailbox);
    const watcher = system.spawnAnonymous(
      typedActor<WatcherMessage>(typedStashingWatcher()),
      watcherOptions,
    );

    await stashAndReplayADeath(system, watcher);

    // The gap, executed.  `StashBuffer` holds bare messages, so
    // `prependUserMessages` rebuilds the envelope from scratch: same message,
    // no sender, and none of the envelope-level state — `undroppable` among it.
    //
    // Asserting the defect rather than the fix is deliberate, and it is a pin
    // in both directions.  Closing #1319 turns this red, which is where the
    // qualification in the JSDoc and on both mailboxes pages has to come out.
    expect(mailbox.replayedEnvelopes.length).toBe(1);
    const replayed = mailbox.replayedEnvelopes[0]!;
    expect(replayed.message).toBeInstanceOf(Terminated);
    expect(replayed.sender).toBeNull();
    expect(replayed.undroppable).toBeUndefined();

    await system.terminate();
  });
});

/* ---------------------------- the prose that says so ----------------------- */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const MAILBOX_SOURCE = join(REPOSITORY_ROOT, 'src', 'internal', 'Mailbox.ts');
const ACTOR_CELL_SOURCE = join(REPOSITORY_ROOT, 'src', 'internal', 'ActorCell.ts');
const ACTOR_OPTIONS_SOURCE = join(REPOSITORY_ROOT, 'src', 'ActorOptions.ts');
const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

/** The mailboxes page in each language, keyed by the language it is written in. */
const MAILBOX_PAGES: ReadonlyMap<string, string> = new Map([
  ['en', join(DOCUMENTATION_ROOT, 'fundamentals', 'mailboxes.mdx')],
  ['de', join(DOCUMENTATION_ROOT, 'de', 'fundamentals', 'mailboxes.mdx')],
]);

/** The JSDoc block immediately above a declaration, without its delimiters. */
const jsDocAbove = (source: string, declaration: string): string => {
  const at = source.indexOf(declaration);
  expect(at).toBeGreaterThan(-1);
  const open = source.lastIndexOf('/**', at);
  expect(open).toBeGreaterThan(-1);
  const close = source.indexOf('*/', open);
  return source.slice(open, close);
};

/**
 * One `## ` section of an MDX page, found by a substring of its heading.
 *
 * A substring rather than the whole heading because the two languages
 * translate it; `Mailboxes +` is common to both and unique on either page.
 */
const sectionOf = (page: string, headingContains: string): string => {
  const lines = page.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(headingContains));
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

describe('the survival claim is qualified where it is made — #729, #1319', () => {
  test("Envelope.undroppable's JSDoc names the replay that does not preserve it", () => {
    const jsDoc = jsDocAbove(readFileSync(MAILBOX_SOURCE, 'utf8'), 'readonly undroppable?: boolean;');

    // The claim is true of one replay and false of the other, so naming the
    // round trip without naming `withStash` is the defect this pins.  The issue
    // number is what binds the qualification to the gap: remove the gap and this
    // reference is what a reader follows to find out whether it is still true.
    expect(jsDoc).toContain('withStash');
    expect(jsDoc).toContain('#1319');
  });

  for (const [language, path] of MAILBOX_PAGES) {
    test(`the mailboxes page says which replay preserves the marker (${language})`, () => {
      const stashSection = sectionOf(readFileSync(path, 'utf8'), 'Mailboxes +');

      // A code identifier, so the assertion is the same in both languages —
      // which is also the rule the mirrored pages follow: prose is translated,
      // code is not.  Issue numbers deliberately are not asserted here; the
      // user-facing pages carry none anywhere.
      expect(stashSection).toContain('withStash');
    });
  }
});

/**
 * The three JSDoc blocks that count the senders using the exempt door, and the
 * declaration each one sits above.
 *
 * They are three copies of one fact, which is how the count went stale: #985
 * added the third sender and updated two of them.  A reader who lands on the
 * cell — the file that owns the door — was told there are two.
 */
const EXEMPT_DOOR_BLOCKS: ReadonlyMap<string, { readonly source: string; readonly declaration: string }> =
  new Map([
    ['Envelope.undroppable', { source: MAILBOX_SOURCE, declaration: 'readonly undroppable?: boolean;' }],
    ['ActorOptions.mailboxCapacity', { source: ACTOR_OPTIONS_SOURCE, declaration: 'readonly mailboxCapacity?: number;' }],
    ['ActorCell._createMailbox', { source: ACTOR_CELL_SOURCE, declaration: 'private _createMailbox(' }],
  ]);

/**
 * The spelled-out count in "Three senders use it" / "Three envelopes take it".
 *
 * The line-leading `*` has to go before the whitespace is collapsed, or a count
 * that wraps mid-phrase reads as `Three * senders` and matches nothing — which
 * is a guard that passes for the wrong reason on exactly the sites whose prose
 * is longest.
 */
const senderCountOf = (jsDoc: string): string => {
  const prose = jsDoc.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
  const counted = /\b(One|Two|Three|Four|Five|Six)\s+(?:senders?|envelopes?)\b/.exec(prose);
  expect(counted).not.toBeNull();
  return counted![1]!;
};

describe('the three descriptions of the exempt door agree — #729, #717, #985', () => {
  test('every one of them counts the same senders and names all three issues', () => {
    const counts = new Map<string, string>();
    for (const [site, { source, declaration }] of EXEMPT_DOOR_BLOCKS) {
      const jsDoc = jsDocAbove(readFileSync(source, 'utf8'), declaration);
      // The issue markers are what tie the count to reality rather than only to
      // the other two copies: three agreeing blocks could still all be wrong.
      expect(jsDoc).toContain('#717');
      expect(jsDoc).toContain('#985');
      counts.set(site, senderCountOf(jsDoc));
    }
    expect([...new Set(counts.values())]).toEqual(['Three']);
  });
});
