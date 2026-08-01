/**
 * Append serialization for the Cassandra journal (#475).
 *
 * A Cassandra `INSERT` is an upsert, so a plain "read head → check
 * expectedSeq → INSERT" append lets two writers that both read head `N`
 * both write `sequence_nr = N+1` — the second silently overwriting the
 * first while both callers are told they persisted.  The journal claims
 * its sequence range with a lightweight transaction on the metadata row
 * to close that; these tests hold it to the same one-winner contract the
 * relational backends get for free from their primary key.
 *
 * `FakeCassandraClient.execute` is async, so racing appends interleave at
 * every `await` — the race is deterministic here, not timing-dependent.
 */
import { describe, expect, test } from 'bun:test';
import {
  CassandraJournal,
  CassandraJournalOptions,
  JournalConcurrencyError,
  type CassandraBatchQuery,
  type CassandraRowResult,
} from '../../../../src/persistence/index.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';

function journalWith(
  client: FakeCassandraClient,
  lightweightTransactions?: boolean,
): CassandraJournal {
  let options = CassandraJournalOptions.create()
    .withContactPoints(['fake'])
    .withKeyspace('app')
    .withClient(client);
  if (lightweightTransactions !== undefined) {
    options = options.withLightweightTransactions(lightweightTransactions);
  }
  return new CassandraJournal(options);
}

type RaceOutcome<E> = {
  readonly winners: Array<{ index: number; events: ReadonlyArray<{ sequenceNr: number; event: E }> }>;
  readonly losers: Array<{ index: number; error: Error }>;
};

/** Fire `count` appends at the same `expectedSeq` and split the outcomes. */
async function race(
  journal: CassandraJournal,
  persistenceId: string,
  expectedSeq: number,
  count: number,
): Promise<RaceOutcome<string>> {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => journal.append(persistenceId, [`event-${i}`], expectedSeq)),
  );
  const winners: RaceOutcome<string>['winners'] = [];
  const losers: RaceOutcome<string>['losers'] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') winners.push({ index, events: result.value });
    else losers.push({ index, error: result.reason as Error });
  });
  return { winners, losers };
}

describe('CassandraJournal — concurrent appends are serialized', () => {
  test('six appends at expectedSeq 0 leave exactly one winner', async () => {
    const journal = journalWith(new FakeCassandraClient());
    const { winners, losers } = await race(journal, 'pid', 0, 6);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(5);
    for (const loser of losers) {
      expect(loser.error).toBeInstanceOf(JournalConcurrencyError);
    }
  });

  test('the head advances exactly once and holds the winner\'s event', async () => {
    const journal = journalWith(new FakeCassandraClient());
    const { winners } = await race(journal, 'pid', 0, 6);

    expect(await journal.highestSeq('pid')).toBe(1);
    const stored = await journal.read<string>('pid', 1);
    expect(stored).toHaveLength(1);
    // The surviving row must be the one the winner was told it wrote — an
    // overwrite would leave a different payload under the same seq.
    expect(stored[0]!.event).toBe(winners[0]!.events[0]!.event);
    expect(stored[0]!.sequenceNr).toBe(1);
  });

  test('losers report the head the winner left behind', async () => {
    const journal = journalWith(new FakeCassandraClient());
    const { losers } = await race(journal, 'pid', 0, 4);

    for (const loser of losers) {
      const error = loser.error as JournalConcurrencyError;
      expect(error.persistenceId).toBe('pid');
      expect(error.expectedSeq).toBe(0);
      expect(error.actualSeq).toBe(1);
    }
  });

  test('the same holds mid-stream, where the claim is an UPDATE ... IF', async () => {
    const journal = journalWith(new FakeCassandraClient());
    await journal.append('pid', ['e1', 'e2', 'e3'], 0);

    const { winners, losers } = await race(journal, 'pid', 3, 5);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const loser of losers) {
      expect((loser.error as JournalConcurrencyError).actualSeq).toBe(4);
    }
    expect(await journal.highestSeq('pid')).toBe(4);
    expect((await journal.read('pid', 1)).map((e) => e.sequenceNr)).toEqual([1, 2, 3, 4]);
  });

  test('a multi-event winner lands its whole batch, losers land nothing', async () => {
    const journal = journalWith(new FakeCassandraClient());
    const settled = await Promise.allSettled([
      journal.append('pid', ['a1', 'a2', 'a3'], 0),
      journal.append('pid', ['b1', 'b2', 'b3'], 0),
      journal.append('pid', ['c1', 'c2', 'c3'], 0),
    ]);
    const winners = settled.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);

    const stored = await journal.read<string>('pid', 1);
    expect(stored.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);
    // All three surviving payloads come from one writer — no interleaving.
    const prefixes = new Set(stored.map((e) => e.event[0]));
    expect(prefixes.size).toBe(1);
    expect(await journal.highestSeq('pid')).toBe(3);
  });

  test('races on different persistence ids do not interfere', async () => {
    const journal = journalWith(new FakeCassandraClient());
    const settled = await Promise.allSettled([
      journal.append('pid-a', ['a'], 0),
      journal.append('pid-b', ['b'], 0),
      journal.append('pid-c', ['c'], 0),
    ]);

    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await journal.highestSeq('pid-a')).toBe(1);
    expect(await journal.highestSeq('pid-b')).toBe(1);
    expect(await journal.highestSeq('pid-c')).toBe(1);
  });

  test('sequential appends are unaffected', async () => {
    const journal = journalWith(new FakeCassandraClient());
    await journal.append('pid', ['e1', 'e2'], 0);
    await journal.append('pid', ['e3'], 2);

    expect(await journal.highestSeq('pid')).toBe(3);
    expect((await journal.read<string>('pid', 1)).map((e) => e.event)).toEqual(['e1', 'e2', 'e3']);
    expect(await journal.persistenceIds()).toContain('pid');
  });
});

describe('CassandraJournal — a failed event batch releases its claim', () => {
  /** Fails the Nth batch, so the claim is committed but the events never land. */
  class FlakyBatchClient extends FakeCassandraClient {
    failNextBatch = false;

    override async batch(
      queries: ReadonlyArray<CassandraBatchQuery>,
      options?: { prepare?: boolean; logged?: boolean; consistency?: number },
    ): Promise<void> {
      if (this.failNextBatch) {
        this.failNextBatch = false;
        throw new Error('simulated write timeout');
      }
      return super.batch(queries, options);
    }
  }

  test('a retry at the same expectedSeq succeeds after the batch failed', async () => {
    const client = new FlakyBatchClient();
    const journal = journalWith(client);

    client.failNextBatch = true;
    await expect(journal.append('pid', ['e1'], 0)).rejects.toThrow('simulated write timeout');
    // The claim was rolled back, so the head is back where it started and
    // the retry may re-claim the same range instead of leaving a gap.
    expect(await journal.highestSeq('pid')).toBe(0);

    const retried = await journal.append('pid', ['e1'], 0);
    expect(retried[0]!.sequenceNr).toBe(1);
    expect((await journal.read<string>('pid', 1)).map((e) => e.event)).toEqual(['e1']);
  });

  test('mid-stream, the release rewinds to the previous head', async () => {
    const client = new FlakyBatchClient();
    const journal = journalWith(client);
    await journal.append('pid', ['e1', 'e2'], 0);

    client.failNextBatch = true;
    await expect(journal.append('pid', ['e3'], 2)).rejects.toThrow('simulated write timeout');
    expect(await journal.highestSeq('pid')).toBe(2);

    const retried = await journal.append('pid', ['e3'], 2);
    expect(retried[0]!.sequenceNr).toBe(3);
  });
});

describe('CassandraJournal — lightweightTransactions opt-out', () => {
  /** Records every statement so the tests can assert on conditional CQL. */
  class RecordingClient extends FakeCassandraClient {
    readonly statements: string[] = [];

    override async execute(
      query: string,
      params: ReadonlyArray<unknown> = [],
      options?: { prepare?: boolean; consistency?: number },
    ): Promise<CassandraRowResult> {
      this.statements.push(query.trim().replace(/\s+/g, ' '));
      return super.execute(query, params, options);
    }
  }

  /** Conditional data-path statements only — DDL is `IF NOT EXISTS` too. */
  const conditionals = (client: RecordingClient): string[] =>
    client.statements.filter((s) => !/^CREATE /i.test(s) && /\bIF (NOT EXISTS|\w+ =)/i.test(s));

  test('LWT is on by default — the append claims its range conditionally', async () => {
    const client = new RecordingClient();
    await journalWith(client).append('pid', ['e1'], 0);

    expect(conditionals(client)).toHaveLength(1);
    expect(conditionals(client)[0]).toContain('IF NOT EXISTS');
  });

  test('mid-stream the claim is conditional on the current head', async () => {
    const client = new RecordingClient();
    const journal = journalWith(client);
    await journal.append('pid', ['e1'], 0);
    client.statements.length = 0;
    await journal.append('pid', ['e2'], 1);

    expect(conditionals(client)).toHaveLength(1);
    expect(conditionals(client)[0]).toContain('IF max_sequence_nr = ?');
  });

  test('opting out issues no conditional statement and still round-trips', async () => {
    const client = new RecordingClient();
    const journal = journalWith(client, false);
    await journal.append('pid', ['e1', 'e2'], 0);
    await journal.append('pid', ['e3'], 2);

    expect(conditionals(client)).toEqual([]);
    expect(await journal.highestSeq('pid')).toBe(3);
    expect((await journal.read<string>('pid', 1)).map((e) => e.event)).toEqual(['e1', 'e2', 'e3']);
  });

  test('opting out reinstates the lost-write race — the reason it is not the default', async () => {
    const journal = journalWith(new FakeCassandraClient(), false);
    const { winners } = await race(journal, 'pid', 0, 4);

    // Documents the trade rather than endorsing it: without the LWT every
    // caller is told it won and all but one event is silently overwritten.
    expect(winners.length).toBeGreaterThan(1);
    expect(await journal.read('pid', 1)).toHaveLength(1);
  });
});

describe('CassandraJournal — serial consistency for the claim', () => {
  type ExecuteOptions = { prepare?: boolean; consistency?: number; serialConsistency?: number };

  /** Pairs each statement with the options it was executed under. */
  class OptionsSpyClient extends FakeCassandraClient {
    readonly calls: Array<{ statement: string; options?: ExecuteOptions }> = [];

    override async execute(
      query: string,
      params: ReadonlyArray<unknown> = [],
      options?: ExecuteOptions,
    ): Promise<CassandraRowResult> {
      this.calls.push({ statement: query.trim().replace(/\s+/g, ' '), options });
      return super.execute(query, params, options);
    }
  }

  const conditionalCalls = (client: OptionsSpyClient) =>
    client.calls.filter((c) => !/^CREATE /i.test(c.statement) && /\bIF (NOT EXISTS|\w+ =)/i.test(c.statement));

  test('it rides along on the claim only, never on plain reads and writes', async () => {
    const client = new OptionsSpyClient();
    const journal = new CassandraJournal(
      CassandraJournalOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('app')
        .withConsistency(6)
        .withSerialConsistency(9)
        .withClient(client),
    );
    await journal.append('pid', ['e1'], 0);

    const claims = conditionalCalls(client);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.options?.serialConsistency).toBe(9);
    expect(claims[0]!.options?.consistency).toBe(6);

    // Everything else is a normal quorum operation — Paxos options there
    // would be meaningless at best and misleading at worst.
    for (const call of client.calls.filter((c) => !claims.includes(c))) {
      expect(call.options?.serialConsistency).toBeUndefined();
    }
  });

  test('unset means the driver keeps its own default', async () => {
    const client = new OptionsSpyClient();
    const journal = journalWith(client);
    await journal.append('pid', ['e1'], 0);

    for (const call of client.calls) {
      expect(call.options?.serialConsistency).toBeUndefined();
    }
  });
});

describe('CassandraJournal — a driver that ignores the conditional fails loudly', () => {
  /** Strips the `[applied]` marker, as a non-LWT execution path would. */
  class NonConditionalClient extends FakeCassandraClient {
    override async execute(
      query: string,
      params: ReadonlyArray<unknown> = [],
      options?: { prepare?: boolean; consistency?: number },
    ): Promise<CassandraRowResult> {
      const result = await super.execute(query, params, options);
      return { rows: result.rows.map(({ ['[applied]']: _applied, ...rest }) => rest) };
    }
  }

  test('a missing [applied] marker raises instead of assuming success', async () => {
    const journal = journalWith(new NonConditionalClient());
    await expect(journal.append('pid', ['e1'], 0)).rejects.toThrow(/\[applied\] marker/);
    // Nothing was written — failing closed beats silently overwriting.
    expect(await journal.read('pid', 1)).toHaveLength(0);
  });
});
