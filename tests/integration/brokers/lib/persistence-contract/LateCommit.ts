/**
 * By-tag read side under a late commit (#957) — one scenario set, run against
 * every journal harness.
 *
 * Every journal stamps an event's `timestamp` before its write commits, and a
 * by-tag `Offset` orders on that timestamp first.  So a slow writer's event can
 * become visible *after* a by-tag consumer has moved past the timestamp it
 * carries.  The scenarios stage exactly that: writer B appends and is
 * delivered, then writer A commits an event stamped a second *before* B's.  A
 * consumer that only reads forward from its cursor never sees A; one that
 * re-reads its lookback window and deduplicates on `(persistenceId,
 * sequenceNr)` delivers A once and B once.
 *
 * The stamp is staged by pinning `Date.now` around A's append — the one value
 * every journal's `append` reads before it writes — rather than by slowing a
 * transaction down, because only the stamp-to-visibility order matters and the
 * pin reproduces it on a fake driver and a live database alike.
 *
 * A harness without `makeQuery` runs these against {@link InMemoryQuery}, which
 * is the query such a backend really gets: there is no backend whose by-tag
 * consumer escapes the question.
 */
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { InMemoryDurableStateStore } from '../../../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import { DurableStateOffsetStore } from '../../../../../src/persistence/projection/OffsetStore.js';
import { ProjectionActor } from '../../../../../src/persistence/projection/ProjectionActor.js';
import { ByTagProjectionOptions } from '../../../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import {
  offsetStart,
  type PersistenceQuery,
  type TaggedEvent,
} from '../../../../../src/persistence/query/PersistenceQuery.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import { assertEqual } from './Assert.js';
import { closeQuietly, type ContractScenario, type JournalHarness } from './Types.js';

/** How far behind writer B's stamp writer A's event is stamped — well inside the default window. */
const LATE_STAMP_LEAD_MS = 1_000;

/** Poll cadence for the consumers under test: fast enough that a scenario stays well inside the test cap. */
const CONSUMER_POLL_INTERVAL_MS = 10;

function tagsSkip(harness: JournalHarness): string | null {
  return harness.capabilities?.tags === false ? 'store does not support tags' : null;
}

function queryOf(harness: JournalHarness, journal: Journal): PersistenceQuery {
  return harness.makeQuery?.(journal) ?? new InMemoryQuery(journal);
}

/** Run `append` with the wall clock pinned to `stamp`, the way a writer that called `Date.now()` that long ago would. */
async function appendStampedAt<T>(stamp: number, append: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => stamp;
  try {
    return await append();
  } finally {
    Date.now = realNow;
  }
}

/** The stamp the journal gave the newest event of `persistenceId`. */
async function stampOf(journal: Journal, persistenceId: string): Promise<number> {
  const events = await journal.read(persistenceId, 1);
  return events[events.length - 1]!.timestamp;
}

function newSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
}

const keyOf = (event: { persistenceId: string; sequenceNr: number }): string =>
  `${event.persistenceId}#${event.sequenceNr}`;

export function lateCommitContractScenarios(): ContractScenario<JournalHarness>[] {
  return [
    {
      name: 'a by-tag projection delivers events committed behind its cursor exactly once, across a restart',
      skip: tagsSkip,
      async run(harness) {
        const journal = await harness.make();
        const tag = harness.pid('late-commit-projection-tag');
        const writerA = harness.pid('late-commit-projection-a');
        const writerB = harness.pid('late-commit-projection-b');
        const durableState = new InMemoryDurableStateStore();
        const firstSystem = newSystem('late-commit-projection-1');
        const secondSystem = newSystem('late-commit-projection-2');
        try {
          const query = queryOf(harness, journal);
          const firstRun: string[] = [];
          const firstOptions = ByTagProjectionOptions.create<string>()
            .withName('late-commit')
            .withQuery(query)
            .withOffsetStore(new DurableStateOffsetStore(durableState))
            .withTag(tag)
            .withHandle((event) => { firstRun.push(keyOf(event)); })
            .withLiveOptions({ pollIntervalMs: CONSUMER_POLL_INTERVAL_MS });

          await journal.append(writerB, [{ event: 'b1', tags: [tag] }], 0);
          const first = ProjectionActor.byTag<string>(firstSystem, firstOptions);
          await awaitCondition(() => firstRun.includes(`${writerB}#1`), {
            timeoutMs: 2_000,
            label: "writer B's event reached the projection and moved its cursor",
          });

          // A called Date.now() a second before B did and committed only now.
          const stampB = await stampOf(journal, writerB);
          await appendStampedAt(stampB - LATE_STAMP_LEAD_MS, () =>
            journal.append(writerA, [{ event: 'a1', tags: [tag] }], 0));
          await awaitCondition(() => firstRun.includes(`${writerA}#1`), {
            timeoutMs: 2_000,
            label: "writer A's late-committed event, stamped behind the cursor, reached the projection",
          });

          await journal.append(writerB, [{ event: 'b2', tags: [tag] }], 1);
          await awaitCondition(() => firstRun.includes(`${writerB}#2`), {
            timeoutMs: 2_000,
            label: "writer B's next event reached the projection",
          });
          assertEqual(firstRun, [`${writerB}#1`, `${writerA}#1`, `${writerB}#2`],
            'each event reaches the handler exactly once, the late one included');

          first.stop();
          await firstSystem.terminate();

          // While the projection is down, A commits a second event stamped
          // behind the saved cursor.  Only a cursor that saved its window can
          // tell this one from the three it already handled.
          const stampB2 = await stampOf(journal, writerB);
          await appendStampedAt(stampB2 - LATE_STAMP_LEAD_MS, () =>
            journal.append(writerA, [{ event: 'a2', tags: [tag] }], 1));

          // A restart reloads the cursor from durable state.  The lookback
          // window re-reads every event above; what it delivered before must
          // stay delivered, so only the two new ones may reach the handler.
          const secondRun: string[] = [];
          const secondOptions = ByTagProjectionOptions.create<string>()
            .withName('late-commit')
            .withQuery(query)
            .withOffsetStore(new DurableStateOffsetStore(durableState))
            .withTag(tag)
            .withHandle((event) => { secondRun.push(keyOf(event)); })
            .withLiveOptions({ pollIntervalMs: CONSUMER_POLL_INTERVAL_MS });
          await journal.append(writerB, [{ event: 'b3', tags: [tag] }], 2);
          ProjectionActor.byTag<string>(secondSystem, secondOptions);
          await awaitCondition(() => secondRun.includes(`${writerB}#3`), {
            timeoutMs: 2_000,
            label: 'the restarted projection delivered the event appended while it was down',
          });
          assertEqual(secondRun, [`${writerA}#2`, `${writerB}#3`],
            'the restarted projection delivers the late event committed while it was down, '
            + 'and re-delivers nothing its window already delivered');
        } finally {
          await firstSystem.terminate();
          await secondSystem.terminate();
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'a live eventsByTag stream delivers an event committed behind its position exactly once',
      skip: tagsSkip,
      async run(harness) {
        const journal = await harness.make();
        const tag = harness.pid('late-commit-stream-tag');
        const writerA = harness.pid('late-commit-stream-a');
        const writerB = harness.pid('late-commit-stream-b');
        const iterator = queryOf(harness, journal)
          .eventsByTag<string>(tag, offsetStart, { pollIntervalMs: CONSUMER_POLL_INTERVAL_MS })[Symbol.asyncIterator]();
        const delivered: string[] = [];
        let failure: unknown = null;
        const pump = (async (): Promise<void> => {
          for (;;) {
            const next: IteratorResult<TaggedEvent<string>> = await iterator.next();
            if (next.done) return;
            delivered.push(keyOf(next.value.event));
          }
        })().catch((error: unknown) => { failure = error; });
        try {
          await journal.append(writerB, [{ event: 'b1', tags: [tag] }], 0);
          await awaitCondition(() => failure !== null || delivered.includes(`${writerB}#1`), {
            timeoutMs: 2_000,
            label: "writer B's event reached the stream",
          });

          const stampB = await stampOf(journal, writerB);
          await appendStampedAt(stampB - LATE_STAMP_LEAD_MS, () =>
            journal.append(writerA, [{ event: 'a1', tags: [tag] }], 0));
          await awaitCondition(() => failure !== null || delivered.includes(`${writerA}#1`), {
            timeoutMs: 2_000,
            label: "writer A's late-committed event, stamped behind the stream's position, reached the stream",
          });

          await journal.append(writerB, [{ event: 'b2', tags: [tag] }], 1);
          await awaitCondition(() => failure !== null || delivered.includes(`${writerB}#2`), {
            timeoutMs: 2_000,
            label: "writer B's next event reached the stream",
          });
          assertEqual(failure, null, 'the stream did not fail');
          assertEqual(delivered, [`${writerB}#1`, `${writerA}#1`, `${writerB}#2`],
            'each event reaches the stream exactly once, the late one included');
        } finally {
          await iterator.return?.();
          await pump;
          await closeQuietly(journal);
        }
      },
    },
  ];
}
