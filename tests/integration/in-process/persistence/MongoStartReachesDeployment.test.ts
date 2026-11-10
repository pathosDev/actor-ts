import { describe, expect, test } from 'bun:test';
import {
  JournalError,
  MongoDurableStateStore,
  MongoDurableStateStoreOptions,
  MongoJournal,
  MongoJournalOptions,
  MongoSnapshotStore,
  MongoSnapshotStoreOptions,
} from '../../../../src/persistence/index.js';
import type {
  MongoClientLike,
  MongoCollectionLike,
  MongoCursorLike,
  MongoDatabaseLike,
  MongoDeleteResult,
  MongoDocument,
  MongoUpdateResult,
} from '../../../../src/persistence/journals/MongoClient.js';

/**
 * A MongoDB store's open reaches the deployment, whatever auto-create-indexes
 * says and wherever the client came from (#1473).
 *
 * `start()` — the boot-time open a selected store runs — promises that a
 * deployment the node cannot reach fails the startup rather than the first
 * persisted message.  A store built over a pre-built client used to send
 * nothing when it opened with auto-create-indexes off, and the durable-state
 * store, which has no index to create, sent nothing at all, so `start()`
 * resolved against a deployment that refused every connection.  The open now
 * sends one `{ ping: 1 }`, and its failure fails the open, naming the store.
 *
 * The deployment here is a recorder that refuses every call while it is told
 * to — the shape of a server that is down — so what each open attempts is
 * visible, not just whether it failed.
 */

const REFUSED = 'connect ECONNREFUSED 127.0.0.1:27017';
const PING = 'command ping';

/** Every call a store makes, in order, refused with `refusal` while it is set. */
class RecordingDeployment {
  readonly calls: string[] = [];

  constructor(public refusal: Error | null = null) {}

  async attempt<TAnswer>(call: string, answer: TAnswer): Promise<TAnswer> {
    this.calls.push(call);
    if (this.refusal !== null) throw this.refusal;
    return answer;
  }
}

class RecordingCursor implements MongoCursorLike<MongoDocument> {
  constructor(private readonly deployment: RecordingDeployment, private readonly collection: string) {}

  sort(): MongoCursorLike<MongoDocument> { return this; }
  limit(): MongoCursorLike<MongoDocument> { return this; }
  skip(): MongoCursorLike<MongoDocument> { return this; }
  toArray(): Promise<MongoDocument[]> { return this.deployment.attempt(`find ${this.collection}`, []); }
}

const NOTHING_UPDATED: MongoUpdateResult = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
const NOTHING_DELETED: MongoDeleteResult = { deletedCount: 0 };

class RecordingCollection implements MongoCollectionLike {
  constructor(private readonly deployment: RecordingDeployment, private readonly name: string) {}

  insertMany(): Promise<unknown> { return this.deployment.attempt(`insertMany ${this.name}`, {}); }
  insertOne(): Promise<unknown> { return this.deployment.attempt(`insertOne ${this.name}`, {}); }
  find(): MongoCursorLike<MongoDocument> { return new RecordingCursor(this.deployment, this.name); }
  findOne(): Promise<MongoDocument | null> { return this.deployment.attempt(`findOne ${this.name}`, null); }
  updateOne(): Promise<MongoUpdateResult> { return this.deployment.attempt(`updateOne ${this.name}`, NOTHING_UPDATED); }
  deleteMany(): Promise<MongoDeleteResult> { return this.deployment.attempt(`deleteMany ${this.name}`, NOTHING_DELETED); }
  deleteOne(): Promise<MongoDeleteResult> { return this.deployment.attempt(`deleteOne ${this.name}`, NOTHING_DELETED); }
  distinct(): Promise<unknown[]> { return this.deployment.attempt(`distinct ${this.name}`, []); }
  createIndex(): Promise<string> { return this.deployment.attempt(`createIndex ${this.name}`, 'index'); }
}

class RecordingDatabase implements MongoDatabaseLike {
  constructor(private readonly deployment: RecordingDeployment) {}

  collection<TDocument extends MongoDocument = MongoDocument>(name: string): MongoCollectionLike<TDocument> {
    return new RecordingCollection(this.deployment, name) as unknown as MongoCollectionLike<TDocument>;
  }

  command(command: MongoDocument): Promise<MongoDocument> {
    return this.deployment.attempt(`command ${Object.keys(command).join(',')}`, { ok: 1 });
  }
}

/** A pre-built client over the recorder — caller-owned, as `withClient` makes it. */
class RecordingClient implements MongoClientLike {
  constructor(private readonly deployment: RecordingDeployment) {}

  connect(): Promise<unknown> { return this.deployment.attempt('connect', this); }
  db(): MongoDatabaseLike { return new RecordingDatabase(this.deployment); }
  async close(): Promise<void> {}
}

/** What a case hands back: the store, and one read that reaches the deployment through it. */
type OpenedStore = {
  readonly store: { start(): Promise<void>; close(): Promise<void> };
  readonly operate: () => Promise<unknown>;
};

type StoreCase = {
  readonly label: string;
  readonly open: (client: MongoClientLike) => OpenedStore;
};

/** The three stores as an operator runs them over a schema of their own: no index created by the store. */
const storeCases: StoreCase[] = [
  {
    label: 'MongoJournal',
    open: (client) => {
      const journalOptions = MongoJournalOptions.create()
        .withClient(client)
        .withAutoCreateIndexes(false);
      const store = new MongoJournal(journalOptions);
      return { store, operate: () => store.highestSeq('p-1') };
    },
  },
  {
    label: 'MongoSnapshotStore',
    open: (client) => {
      const snapshotStoreOptions = MongoSnapshotStoreOptions.create()
        .withClient(client)
        .withAutoCreateIndexes(false);
      const store = new MongoSnapshotStore(snapshotStoreOptions);
      return { store, operate: () => store.loadLatest('p-1') };
    },
  },
  {
    // No index option at all: `_id` is the store's only key, so it never creates one.
    label: 'MongoDurableStateStore',
    open: (client) => {
      const durableStateStoreOptions = MongoDurableStateStoreOptions.create().withClient(client);
      const store = new MongoDurableStateStore(durableStateStoreOptions);
      return { store, operate: () => store.load('p-1') };
    },
  },
];

async function rejectionOf(operation: Promise<unknown>): Promise<Error | undefined> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

const countOf = (calls: ReadonlyArray<string>, call: string): number => calls.filter((each) => each === call).length;

describe('a MongoDB store reaches its deployment when it opens (#1473)', () => {
  test.each(storeCases)(
    '$label: over a deployment that refuses every connection, start() rejects, naming the store',
    async ({ label, open }) => {
      const deployment = new RecordingDeployment(new Error(REFUSED));
      const { store } = open(new RecordingClient(deployment));

      const error = await rejectionOf(store.start());

      expect(error?.message ?? 'resolved').toBe(`${label}.open failed: ${REFUSED}`);
      expect(error).toBeInstanceOf(JournalError);
      expect((error as JournalError).cause).toBe(deployment.refusal);
      // One call was attempted, and it was the ping.
      expect(deployment.calls).toEqual([PING]);
      await store.close();
    },
  );

  test.each(storeCases)(
    '$label: the open costs one ping, and neither a second start() nor an operation repeats it',
    async ({ open }) => {
      const deployment = new RecordingDeployment();
      const { store, operate } = open(new RecordingClient(deployment));

      await store.start();
      expect(deployment.calls).toEqual([PING]);

      await store.start();
      expect(deployment.calls).toEqual([PING]);

      await operate();
      // The read reached the deployment, so "no further ping" is measured
      // against real traffic rather than against silence.
      expect(deployment.calls.length).toBeGreaterThan(1);
      expect(countOf(deployment.calls, PING)).toBe(1);
      await store.close();
    },
  );

  test.each(storeCases)(
    '$label: a refused open is not remembered — once the deployment answers, the next start() pings again and opens',
    async ({ label, open }) => {
      const deployment = new RecordingDeployment(new Error(REFUSED));
      const { store } = open(new RecordingClient(deployment));

      expect((await rejectionOf(store.start()))?.message).toBe(`${label}.open failed: ${REFUSED}`);
      deployment.refusal = null;
      await store.start();

      expect(deployment.calls).toEqual([PING, PING]);
      await store.close();
    },
  );

  test('a journal that creates its indexes pings first, so a refused ping fails the open before any index is tried', async () => {
    const refusing = new RecordingDeployment(new Error(REFUSED));
    const refusingOptions = MongoJournalOptions.create().withClient(new RecordingClient(refusing));
    const refused = new MongoJournal(refusingOptions);

    expect((await rejectionOf(refused.start()))?.message).toBe(`MongoJournal.open failed: ${REFUSED}`);
    expect(refusing.calls).toEqual([PING]);

    const answering = new RecordingDeployment();
    const answeringOptions = MongoJournalOptions.create().withClient(new RecordingClient(answering));
    const journal = new MongoJournal(answeringOptions);
    await journal.start();

    expect(answering.calls[0]).toBe(PING);
    expect(countOf(answering.calls, PING)).toBe(1);
    expect(answering.calls.slice(1).length).toBeGreaterThan(0);
    expect(answering.calls.slice(1).every((call) => call.startsWith('createIndex '))).toBe(true);
    await refused.close();
    await journal.close();
  });
});
