/**
 * #1188 — the coordinator's allocation state, kept in a journal the whole
 * cluster shares.
 */
import { describe, expect, test } from 'bun:test';
import { JournalCoordinatorStateStore, type CoordinatorStateData } from '../../../../src/cluster/sharding/CoordinatorState.js';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';

const TYPE_NAME = 'entity';
const PERSISTENCE_ID = `sharding-coordinator-state-${TYPE_NAME}`;

function snapshot(takenAt: number, shardHome: Array<readonly [number, string]> = []): CoordinatorStateData {
  return { leader: 'sys@h:1', takenAt, regions: [], shardHome, numShards: 12 };
}

describe('JournalCoordinatorStateStore (#1188)', () => {
  test('nothing saved loads as nothing', async () => {
    expect(await new JournalCoordinatorStateStore(new InMemoryJournal()).load(TYPE_NAME)).toBeNull();
  });

  test('a save is what the next store on the same journal loads — the next leader reads the previous one', async () => {
    const journal = new InMemoryJournal();
    await new JournalCoordinatorStateStore(journal).save(TYPE_NAME, snapshot(1, [[3, 'k']]));

    expect(await new JournalCoordinatorStateStore(journal).load(TYPE_NAME)).toEqual(snapshot(1, [[3, 'k']]));
  });

  test('only the latest snapshot is kept: every save compacts what came before it', async () => {
    const journal = new InMemoryJournal();
    const store = new JournalCoordinatorStateStore(journal);
    for (let takenAt = 1; takenAt <= 5; takenAt++) await store.save(TYPE_NAME, snapshot(takenAt));

    expect(await journal.highestSeq(PERSISTENCE_ID)).toBe(5);
    expect((await journal.read(PERSISTENCE_ID, 1)).map((event) => event.sequenceNr)).toEqual([5]);
    expect((await store.load(TYPE_NAME))?.takenAt).toBe(5);
  });

  test('a store whose view is stale cannot overwrite another writer, once — then it adopts the head', async () => {
    const journal = new InMemoryJournal();
    const stale = new JournalCoordinatorStateStore(journal);
    const current = new JournalCoordinatorStateStore(journal);
    await stale.load(TYPE_NAME);
    await current.save(TYPE_NAME, snapshot(2));

    await expect(stale.save(TYPE_NAME, snapshot(1))).rejects.toBeInstanceOf(JournalConcurrencyError);
    expect((await current.load(TYPE_NAME))?.takenAt).toBe(2);

    // The store learned the head from the refusal, so a coordinator that still
    // holds authority is not locked out for good.
    await stale.save(TYPE_NAME, snapshot(3));
    expect((await current.load(TYPE_NAME))?.takenAt).toBe(3);
  });

  test('the stream is its own, apart from the remember-entities registry', async () => {
    const journal = new InMemoryJournal();
    await new JournalCoordinatorStateStore(journal).save(TYPE_NAME, snapshot(1));

    expect(await journal.highestSeq(`sharding-coordinator-${TYPE_NAME}`)).toBe(0);
  });
});
