import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **A ratchet over direct wall-clock reads in `src/` (#1424).**
 *
 * `ManualScheduler` has had virtual time since the TestKit existed, and almost
 * nothing in the framework could see it: `Scheduler` exposed no `now()`, so
 * every component that needed the time read `Date.now()` for itself.  That is
 * a mixed clock, and it is why a test cannot say "this peer went quiet for a
 * minute" — gossip and heartbeat ticks run through the scheduler, so virtual
 * time drives them, but the failure detector read the wall clock, so a hundred
 * advanced ticks all arrived at the same real instant.
 *
 * `src/Clock.ts` is the contract those reads move onto.  Moving 184 of them is
 * not one change, so this file holds the line while they move: **a file may
 * read the wall clock fewer times than the ledger records, never more, and a
 * file the ledger does not name may not read it at all.**
 *
 * It is a ratchet, not an adversary.  `new Date().getTime()`, a captured
 * `const now = Date.now` or a read hidden behind an alias all evade it, and
 * that is fine — the point is that the ordinary way to write one stops being
 * free, and a review has one number to look at.  Same shape as the sibling
 * ratchet over fixed sleeps in `tests/unit/ci/SleepRatchet.test.ts`.
 *
 * **`performance.now()` is deliberately not counted.**  It is monotonic and
 * measures elapsed durations, which is a different question from what time it
 * is; {@link Clock} says so explicitly and does not cover it.  Six such reads
 * exist and they are correct where they are.
 *
 * ## Lowering an entry
 *
 * Ordinary work: move the read onto `system.clock` (or a `Clock` the component
 * takes) and drop the count. Deleting an entry that has reached zero is the
 * end state.
 *
 * ## Raising one
 *
 * Needs a reason written beside it. A genuinely wall-clock value — a member
 * version seed, a gossip sequence seed, a log record's timestamp, an HTTP
 * `Date` header — is one that must survive a `ManualScheduler`, and those stay
 * in the ledger permanently rather than moving. But reach for that only after
 * asking whether the component wants `system.clock`, because that is the answer
 * for most of what is still counted here.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_DIRECTORY = join(REPOSITORY_ROOT, 'src');

/** A single backslash, spelled so no shell heredoc or editor can eat it. */
const BACKSLASH = String.fromCharCode(92);

/**
 * The revision the ledger below was measured at, so a later reader can see how
 * far the tree has moved without re-deriving the baseline.
 */
const LEDGER_REVISION = '2eaab0b4';
const LEDGER_MEASURED_ON = '2026-09-07';

/**
 * The two files where reading the wall clock **is** the implementation.
 *
 * `SystemClock.now()` and `Scheduler.now()` are what every other read is
 * supposed to move onto, so counting them would be counting the fix. Exempt,
 * but not unchecked: the assertion below pins each at exactly one read, so the
 * exemption cannot quietly come to cover a file that grew.
 */
const CANONICAL_CLOCKS: readonly string[] = ['src/Clock.ts', 'src/Scheduler.ts'];

/**
 * Direct wall-clock reads per file, measured at {@link LEDGER_REVISION}:
 * **184 across 78 files**, counting `Date.now()` and a bare `new Date()` over
 * source with comments and string literals blanked.
 *
 * A raw `grep` says 213 across 87 files. The difference is reads inside
 * comments and JSDoc — this file's own prose included — which is exactly why
 * the scanner blanks before it counts.
 */
const LEGACY_WALL_CLOCK_READS: Readonly<Record<string, number>> = {
  'src/ActorSelection.ts': 2,
  'src/ActorSystem.ts': 3,
  'src/Logger.ts': 2,
  'src/cache/InMemoryCache.ts': 8,
  'src/cluster/Cluster.ts': 13,
  'src/cluster/EnvelopeTrust.ts': 1,
  'src/cluster/FailureDetector.ts': 3,
  'src/cluster/PhiAccrualFailureDetector.ts': 4,
  'src/cluster/bootstrap/StableObservation.ts': 5,
  'src/cluster/downing/LeaseMajority.ts': 2,
  'src/cluster/router/MailboxDepthProbe.ts': 3,
  'src/cluster/sharding/CassandraRememberEntitiesStore.ts': 1,
  'src/cluster/sharding/ClusterSharding.ts': 1,
  'src/cluster/sharding/ShardCoordinator.ts': 6,
  'src/cluster/sharding/ShardRegion.ts': 9,
  'src/coordination/leases/InMemoryLease.ts': 4,
  'src/coordination/leases/KubernetesLease.ts': 6,
  'src/crdt/CrdtWireValidation.ts': 1,
  'src/crdt/DistributedData.ts': 2,
  'src/crdt/LWWMap.ts': 2,
  'src/crdt/LWWRegister.ts': 1,
  'src/deadletters/DeadLetterQueue.ts': 2,
  'src/delivery/ConsumerController.ts': 4,
  'src/devtools/cluster/Federation.ts': 3,
  'src/devtools/internal/ClusterMembership.ts': 3,
  'src/devtools/internal/NodeSampler.ts': 1,
  'src/devtools/internal/StatsHistoryStore.ts': 1,
  'src/devtools/send/SendMethods.ts': 1,
  'src/devtools/taps/ActorTreeTap.ts': 5,
  'src/devtools/taps/ClusterTap.ts': 7,
  'src/devtools/taps/EventStreamTap.ts': 2,
  'src/devtools/taps/ExplainTap.ts': 1,
  'src/devtools/taps/MailboxSamplerTap.ts': 1,
  'src/devtools/taps/ProfilerTap.ts': 5,
  'src/devtools/taps/SpanTap.ts': 2,
  'src/devtools/taps/StatsTap.ts': 1,
  'src/discovery/DnsSeedProvider.ts': 1,
  'src/http/HttpExtension.ts': 4,
  'src/internal/ActorCell.ts': 4,
  'src/io/broker/BrokerActor.ts': 7,
  'src/io/broker/GrpcClientActor.ts': 1,
  'src/io/broker/JetStreamActor.ts': 1,
  'src/io/broker/RedisStreamsActor.ts': 1,
  'src/logging/FileSink.ts': 1,
  'src/logging/HttpDelivery.ts': 1,
  'src/logging/MultiSinkLogger.ts': 1,
  'src/pattern/CircuitBreaker.ts': 2,
  'src/persistence/ReplicatedEventSourcedActor.ts': 2,
  'src/persistence/durable-state-stores/DynamoDbDurableStateStore.ts': 1,
  'src/persistence/durable-state-stores/InMemoryDurableStateStore.ts': 1,
  'src/persistence/durable-state-stores/MongoDurableStateStore.ts': 1,
  'src/persistence/durable-state-stores/ObjectStorageDurableStateStore.ts': 1,
  'src/persistence/journals/CassandraJournal.ts': 2,
  'src/persistence/journals/DynamoDbJournal.ts': 1,
  'src/persistence/journals/DynamoDbStore.ts': 2,
  'src/persistence/journals/InMemoryJournal.ts': 1,
  'src/persistence/journals/MongoJournal.ts': 1,
  'src/persistence/journals/SqliteJournal.ts': 1,
  'src/persistence/object-storage/FilesystemObjectStorageBackend.ts': 3,
  'src/persistence/object-storage/S3ObjectStorageBackend.ts': 1,
  'src/persistence/relational/RelationalDurableStateStore.ts': 1,
  'src/persistence/relational/RelationalJournal.ts': 1,
  'src/persistence/relational/RelationalSnapshotStore.ts': 1,
  'src/persistence/snapshot-stores/CassandraSnapshotStore.ts': 1,
  'src/persistence/snapshot-stores/DynamoDbSnapshotStore.ts': 1,
  'src/persistence/snapshot-stores/InMemorySnapshotStore.ts': 1,
  'src/persistence/snapshot-stores/MongoSnapshotStore.ts': 1,
  'src/persistence/snapshot-stores/ObjectStorageSnapshotStore.ts': 1,
  'src/persistence/snapshot-stores/SqliteSnapshotStore.ts': 1,
  'src/runtime/Detect.ts': 1,
  'src/testkit/MockCluster.ts': 1,
  'src/testkit/MultiNodeSpec.ts': 2,
  'src/testkit/ParallelMultiNodeSpec.ts': 2,
  'src/testkit/TestKit.ts': 2,
  'src/testkit/TestProbe.ts': 2,
  'src/tracing/OtelLogsAdapter.ts': 1,
  'src/tracing/RecordingTracer.ts': 2,
  'src/tracing/TeeTracer.ts': 2,
};

/**
 * A floor under the scanner itself.
 *
 * Every assertion below is satisfied by finding nothing, so a scanner that
 * stopped reading — a moved directory, a blanking bug that ate the file —
 * would report a tree with no wall-clock reads at all and pass. 184 were found
 * at {@link LEDGER_REVISION}; the floor sits far enough below that the migration
 * this ratchet exists to enable does not trip it, and far enough above zero to
 * catch a scanner that broke.
 */
const SCANNER_SANITY_FLOOR = 60;

/**
 * `source` with comments and string literals replaced by spaces, character for
 * character so offsets and line numbers still line up.
 *
 * Whole-file rather than per-line, because a template literal spanning lines
 * would otherwise have its later lines read as code — and a doc comment inside
 * one mentioning `Date.now()` would be counted as a read.
 */
function blankNonCode(source: string): string {
  const out = source.split('');
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index++; }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < source.length) { out[index] = ' '; out[index + 1] = ' '; index += 2; }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      out[index] = ' ';
      index++;
      while (index < source.length) {
        if (source[index] === BACKSLASH) {
          out[index] = ' ';
          if (source[index + 1] !== '\n') out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < source.length) out[index] = ' ';
      index++;
      continue;
    }
    index++;
  }
  return out.join('');
}

/** `Date.now()` and a bare `new Date()` — the two ordinary ways to read it. */
const WALL_CLOCK_READ = /\bDate\s*\.\s*now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)/g;

function wallClockReadsIn(source: string): number {
  return blankNonCode(source).match(WALL_CLOCK_READ)?.length ?? 0;
}

/**
 * Every `.ts` this repository wrote under `src/`.
 *
 * `generated/` is skipped: `UiAssets.ts` is a committed build artefact holding
 * a bundled Angular application, and counting a minifier's output would make
 * the ledger a function of the bundler.
 */
function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'generated') continue;
      sourceFiles(join(directory, entry.name), found);
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(join(directory, entry.name));
  }
  return found;
}

const relativeToRoot = (absolutePath: string): string =>
  absolutePath.split(BACKSLASH).join('/')
    .slice(REPOSITORY_ROOT.split(BACKSLASH).join('/').length + 1);

type FileReads = { readonly file: string; readonly reads: number };

const scanned: readonly FileReads[] = sourceFiles(SOURCE_DIRECTORY)
  .map(relativeToRoot)
  .sort()
  .map((file) => ({ file, reads: wallClockReadsIn(readFileSync(join(REPOSITORY_ROOT, file), 'utf8')) }));

const counted = scanned.filter((entry) => !CANONICAL_CLOCKS.includes(entry.file));

describe('the wall clock is read in fewer places over time', () => {
  test('the scanner reads the tree it claims to', () => {
    // Every assertion below is satisfied by finding nothing.
    expect(
      counted.reduce((sum, entry) => sum + entry.reads, 0),
      'The scanner found almost no wall-clock reads in src/, which is far more '
      + 'likely to mean it stopped reading the tree than that the migration '
      + `finished. ${LEGACY_WALL_CLOCK_READS['src/cluster/Cluster.ts'] ?? 0} were `
      + 'expected in Cluster.ts alone.',
    ).toBeGreaterThan(SCANNER_SANITY_FLOOR);
  });

  test.each(counted.filter((entry) => entry.reads > 0))(
    '$file reads the wall clock no more often than the ledger records',
    ({ file, reads }) => {
      const allowed = LEGACY_WALL_CLOCK_READS[file] ?? 0;
      expect(
        reads,
        `${file} reads the wall clock ${reads} time(s); the ledger measured `
        + `${allowed} at ${LEDGER_REVISION}. A component that needs the time `
        + 'should take `system.clock` (or a `Clock` of its own) so a '
        + 'ManualScheduler can drive it — that is what this ratchet is for. If '
        + 'the value genuinely has to survive virtual time (a version seed, a '
        + 'log timestamp, an HTTP Date header), raise the entry and write the '
        + 'reason beside it.',
      ).toBeLessThanOrEqual(allowed);
    },
  );

  test('the ledger names no file that has since gone', () => {
    // An entry for a deleted or renamed file is a budget nothing can spend,
    // and it quietly inflates the number the migration is measured against.
    const present = new Set(scanned.map((entry) => entry.file));
    expect(
      Object.keys(LEGACY_WALL_CLOCK_READS).filter((file) => !present.has(file)),
      'These ledger entries name files that no longer exist. Remove them — an '
      + 'entry nobody can spend makes the remaining work look larger than it is.',
    ).toEqual([]);
  });

  test('the ledger records no file that has already reached zero', () => {
    // The end state of a migrated file is no entry, not an entry of the count
    // it used to have. Left behind, it is a budget a later change can spend.
    const byFile = new Map(scanned.map((entry) => [entry.file, entry.reads]));
    expect(
      Object.keys(LEGACY_WALL_CLOCK_READS).filter((file) => (byFile.get(file) ?? 0) === 0),
      'These files no longer read the wall clock, so their ledger entries are '
      + 'spare budget a later change could spend without anyone noticing. Delete '
      + 'the entries.',
    ).toEqual([]);
  });

  test.each([...CANONICAL_CLOCKS])(
    '%s is still a clock implementation and nothing more',
    (file) => {
      const entry = scanned.find((candidate) => candidate.file === file);
      expect(entry, `${file} is exempt from the ledger but no longer exists`).toBeDefined();
      expect(
        entry?.reads,
        `${file} is exempt because reading the wall clock IS its implementation, `
        + 'which holds while it contains exactly one such read. More than one '
        + 'means the exemption now covers something else too — move that read '
        + 'out, or stop exempting the file.',
      ).toBe(1);
    },
  );

  test('the ledger is dated, so its distance from today is readable', () => {
    // Not a behaviour check. The pair is load-bearing documentation and this is
    // what keeps one of them from being updated without the other.
    expect(LEDGER_REVISION).toMatch(/^[0-9a-f]{8}$/);
    expect(LEDGER_MEASURED_ON).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  });
});

describe('the guards on the guard', () => {
  test('the scanner counts both ordinary spellings', () => {
    expect(wallClockReadsIn('const a = Date.now(); const b = new Date();')).toBe(2);
  });

  test('it does not count a read inside a comment or a string', () => {
    expect(wallClockReadsIn('// Date.now() is not virtualized')).toBe(0);
    expect(wallClockReadsIn('/** Prefer system.clock over Date.now(). */')).toBe(0);
    expect(wallClockReadsIn("const note = 'Date.now()';")).toBe(0);
  });

  test('it does not count a read inside a multi-line template literal', () => {
    // The reason the scanner blanks whole-file rather than per line: a per-line
    // scanner resumes reading code on the second line of a template.
    const source = ['const doc = `', '  Date.now() appears here as prose.', '`;'].join('\n');
    expect(wallClockReadsIn(source)).toBe(0);
  });

  test('it does not count performance.now(), which measures a duration', () => {
    expect(wallClockReadsIn('const started = performance.now();')).toBe(0);
  });

  test('it counts a read that follows a blanked region', () => {
    // A blanking bug that ran off the end would swallow the rest of the file,
    // and every assertion above would pass on a tree it never read.
    const source = "/* Date.now() */ const s = 'x'; const t = Date.now();";
    expect(wallClockReadsIn(source)).toBe(1);
  });
});
