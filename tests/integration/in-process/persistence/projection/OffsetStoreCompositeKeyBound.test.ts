/**
 * `DurableStateOffsetStore` bounds the composite key it writes (#1507).
 *
 * The defect this file pins is that the framework itself manufactures an
 * over-long storage key out of two halves that are each legal.  A
 * `persistenceId` of 250 characters passes `assertValidPersistenceId`
 * (`MAX_PERSISTENCE_ID_LENGTH` is 255), but `DurableStateOffsetStore` does
 * not store the cursor under that id — it stores it under
 * `<projection>|seq|<persistenceId>`, and *that* string is what lands in
 * `durable_state.persistence_id`, declared `VARCHAR(255)` by
 * `MariaDbDialect` and `NVARCHAR(255)` by `MsSqlDialect`.  Under a
 * projection named `orders-projection` the composite is 272 characters.
 *
 * What the backends then do is the reason the refusal belongs here rather
 * than at the driver: MariaDB in strict mode (the default since 10.2.4)
 * raises error 1406, MariaDB with strict mode off truncates to 255 and two
 * projections whose names share a prefix silently share one cursor row, SQL
 * Server raises a truncation error, and Postgres and SQLite (`TEXT`) store
 * the whole thing.  The silent merge is the one that cannot be noticed from
 * inside the process — the projection keeps running and simply skips events.
 *
 * So the assertions below are deliberately about two different things: that
 * the store *refuses* naming both halves, and that no over-long key ever
 * reaches the backend at all.  A store that threw after writing would pass
 * the first and fail the second.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_PERSISTENCE_ID_LENGTH } from '../../../../../src/persistence/Constants.js';
import type {
  DurableStateRecord,
  DurableStateStore,
} from '../../../../../src/persistence/DurableStateStore.js';
import { InMemoryDurableStateStore } from '../../../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import type { PersistenceOptions } from '../../../../../src/persistence/PersistenceOptions.js';
import {
  DurableStateOffsetStore,
  InMemoryOffsetStore,
} from '../../../../../src/persistence/projection/OffsetStore.js';
import {
  offsetStart,
  tagFilterCursorKey,
} from '../../../../../src/persistence/query/PersistenceQuery.js';
import { assertValidPersistenceId } from '../../../../../src/persistence/storage/PersistenceIdValidator.js';
import type { Option } from '../../../../../src/util/Option.js';

/**
 * A real store that remembers every key it was handed.
 *
 * `InMemoryDurableStateStore` behind it keeps the round-trip honest (a fake
 * that only records would make the accepted cases prove nothing), and the
 * recording is what separates "the store threw" from "nothing reached the
 * column" — the second is the property that matters for a backend that
 * truncates instead of raising.
 */
class RecordingDurableStateStore implements DurableStateStore {
  /** Every key handed to the backend, in call order — loads and writes alike. */
  readonly keys: string[] = [];
  private readonly inner = new InMemoryDurableStateStore();

  async upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    this.keys.push(persistenceId);
    return this.inner.upsert<S>(persistenceId, expectedRevision, state, options);
  }

  async load<S>(
    persistenceId: string,
    options?: PersistenceOptions,
  ): Promise<Option<DurableStateRecord<S>>> {
    this.keys.push(persistenceId);
    return this.inner.load<S>(persistenceId, options);
  }

  async delete(persistenceId: string): Promise<void> {
    this.keys.push(persistenceId);
    return this.inner.delete(persistenceId);
  }

  /** Widest key the backend was asked to store — the column-width question. */
  longestKeyLength(): number {
    return this.keys.reduce((longest, key) => Math.max(longest, key.length), 0);
  }
}

/** The projection name from the issue's worked example — 17 characters. */
const PROJECTION_NAME = 'orders-projection';

/** `|seq|` and `|tag|` are both five characters — the composite's overhead. */
const SEPARATOR_LENGTH = 5;

/** Legal on its own: one short of the limit, so the id is never the fault. */
const LONG_PERSISTENCE_ID = 'order-'.padEnd(250, 'x');

/** The widest second half that still fits under {@link PROJECTION_NAME}. */
const FITTING_PERSISTENCE_ID = 'x'.repeat(
  MAX_PERSISTENCE_ID_LENGTH - PROJECTION_NAME.length - SEPARATOR_LENGTH,
);

/**
 * Await a rejection and hand back the error.
 *
 * `await expect(p).rejects.toThrow()` is the shorter spelling, and it is
 * avoided on purpose: it cannot hand the message back for the "names both
 * halves" assertions, which are the whole point of the decision behind this
 * change, and a matcher that only proves *some* error was thrown would pass
 * against a store that rejected for an unrelated reason.
 */
async function rejectionOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the offset store to refuse the composite key, but it resolved');
}

/**
 * Assert that `message` names one half of the key *as a half*, under the
 * role the caller actually passed.
 *
 * `toContain(half)` is not that assertion, and finding out why is what this
 * helper exists to record.  The composite contains both halves as
 * substrings, so a refusal that printed only the key —
 * `assertValidPersistenceId(key)` is the obvious way to write that, and it
 * gets the length rule exactly right — satisfies `toContain` for each half
 * while telling the operator nothing about which one to shorten.  That
 * implementation passed ten of these eleven tests before this helper
 * existed.
 *
 * Quoting is what discriminates: inside the composite the projection name
 * is followed by `|`, never by a closing quote, so `JSON.stringify(half)`
 * appears only when the half was rendered on its own.
 *
 * The role is asserted *adjacent to its half* rather than anywhere in the
 * message, which is the repair (#1507).  Three separate `toContain`s —
 * the quoted half, the length, and the bare role — left the third one
 * vacuous for the tag half, because `|tag|` is in every by-tag message
 * whatever the role says.  Measured: with `TAG_SCOPE` miscopied to
 * `{ token: 'tag', role: 'persistenceId' }`, the very confusion this helper
 * exists to catch, only `saveOffset refuses the composite and names the
 * tag` went red — and it caught it through its own
 * `not.toContain('persistenceId')`, not through the helper.  `loadOffset
 * refuses it as well` stayed green, 11 pass / 1 fail.  One contiguous
 * assertion binds role to half positionally and takes both of them red.
 */
function expectNamesHalf(message: string, role: string, half: string): void {
  expect(message).toContain(`${role} ${JSON.stringify(half)} (${half.length})`);
}

describe('DurableStateOffsetStore — the composite key is bounded', () => {
  test('the premise: a 250-character persistenceId is legal on its own', () => {
    expect(LONG_PERSISTENCE_ID).toHaveLength(250);
    expect(LONG_PERSISTENCE_ID.length).toBeLessThanOrEqual(MAX_PERSISTENCE_ID_LENGTH);
    expect(() => assertValidPersistenceId(LONG_PERSISTENCE_ID)).not.toThrow();
    // ...and that the two halves together are not.  272 is the number the
    // issue quotes; spelling the arithmetic out here is what makes a later
    // change to either constant show up as a failure of the premise rather
    // than as a confusing failure further down.
    expect(PROJECTION_NAME.length + SEPARATOR_LENGTH + LONG_PERSISTENCE_ID.length).toBe(272);
  });

  test('the budget quoted in the docs is the budget the store enforces', () => {
    // `docs/…/persistence/projections.mdx` (EN + DE) tells the reader the
    // second half gets `255 − the projection name − 5`, and spells that out
    // as 233 characters under `orders-projection`.  A documented number with
    // nothing asserting it is a number that goes stale the first time either
    // constant moves; the two tests below this one then show that 233 is
    // accepted and 234 is not.
    expect(FITTING_PERSISTENCE_ID).toHaveLength(233);
  });

  test('saveSequence refuses the composite and names both halves', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    const error = await rejectionOf(offsetStore.saveSequence(PROJECTION_NAME, LONG_PERSISTENCE_ID, 7));

    expectNamesHalf(error.message, 'projection', PROJECTION_NAME);
    expectNamesHalf(error.message, 'persistenceId', LONG_PERSISTENCE_ID);
    expect(error.message).toContain('272');
    expect(error.message).toContain(String(MAX_PERSISTENCE_ID_LENGTH));
    // Naming the halves is only half of actionable; the message also has to
    // say which lever exists.  Neither half can be shortened by the store.
    expect(error.message).toContain('Shorten the projection name');
  });

  test('nothing reaches the backend when the composite is refused', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    await rejectionOf(offsetStore.saveSequence(PROJECTION_NAME, LONG_PERSISTENCE_ID, 7));

    // The column never sees it — the point of refusing before the driver
    // rather than letting a lax backend truncate.
    expect(backend.keys).toEqual([]);
  });

  test('loadSequence refuses the same composite — the key is bounded where it is composed', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    const error = await rejectionOf(offsetStore.loadSequence(PROJECTION_NAME, LONG_PERSISTENCE_ID));

    expectNamesHalf(error.message, 'projection', PROJECTION_NAME);
    expectNamesHalf(error.message, 'persistenceId', LONG_PERSISTENCE_ID);
    expect(backend.keys).toEqual([]);
  });

  test('a composite of exactly the limit is accepted and round-trips', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    await offsetStore.saveSequence(PROJECTION_NAME, FITTING_PERSISTENCE_ID, 7);

    expect(await offsetStore.loadSequence(PROJECTION_NAME, FITTING_PERSISTENCE_ID)).toBe(7);
    // Exactly at the width, not one under it: the bound is `>` and this is
    // the assertion that fails if it ever becomes `>=`.
    expect(backend.longestKeyLength()).toBe(MAX_PERSISTENCE_ID_LENGTH);
  });

  test('one character over the limit is refused', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    const error = await rejectionOf(
      offsetStore.saveSequence(PROJECTION_NAME, `${FITTING_PERSISTENCE_ID}x`, 7),
    );

    expect(error.message).toContain(String(MAX_PERSISTENCE_ID_LENGTH + 1));
    expect(backend.keys).toEqual([]);
  });

  test('an over-long projection name overflows a short id — both halves count', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);
    const longProjectionName = 'p'.repeat(250);

    const error = await rejectionOf(offsetStore.saveSequence(longProjectionName, 'alice', 7));

    expectNamesHalf(error.message, 'projection', longProjectionName);
    expectNamesHalf(error.message, 'persistenceId', 'alice');
    expect(backend.keys).toEqual([]);
  });
});

describe('DurableStateOffsetStore — the by-tag half is bounded too', () => {
  /**
   * The tag half is not an afterthought: `ByTagProjectionActor` keys its
   * cursor on `tagFilterCursorKey(tag)`, which renders a multi-tag filter as
   * `all(a,b)+any(c)+not(d)`, so the second half can outgrow a single tag's
   * own 255-character limit without any one tag being unusual.
   */
  const LONG_TAG = 'tag-'.padEnd(250, 'y');

  test('saveOffset refuses the composite and names the tag, not a persistenceId', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    const error = await rejectionOf(offsetStore.saveOffset(PROJECTION_NAME, LONG_TAG, offsetStart));

    expectNamesHalf(error.message, 'projection', PROJECTION_NAME);
    expectNamesHalf(error.message, 'tag', LONG_TAG);
    // The message has to name the half the caller actually passed, or it
    // sends them looking for an id their by-tag projection never had.
    expect(error.message).not.toContain('persistenceId');
    expect(backend.keys).toEqual([]);
  });

  test('loadOffset refuses it as well', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    const error = await rejectionOf(offsetStore.loadOffset(PROJECTION_NAME, LONG_TAG));

    expectNamesHalf(error.message, 'tag', LONG_TAG);
    expect(backend.keys).toEqual([]);
  });

  test('ten ordinary 21-character tags in one filter already overflow the budget', async () => {
    // How reachable the refusal is decides how much its silence costs, so the
    // population belongs in the tree rather than in a triage note.  Nothing
    // here is unusual: ten tags of the shape `order-lifecycle-NN-eu`, the
    // length of a tag anyone would write, split five/four/one across `all`,
    // `any` and `not`.  The rendered cursor key is 234 characters and the
    // composite under `orders-projection` is 256 — over by exactly one.
    const tags = Array.from(
      { length: 10 },
      (_unused, index) => `order-lifecycle-${String(index + 1).padStart(2, '0')}-eu`,
    );
    expect(tags.every((tag) => tag.length === 21)).toBe(true);

    const cursorKey = tagFilterCursorKey({
      all: tags.slice(0, 5),
      any: tags.slice(5, 9),
      not: tags.slice(9),
    });
    expect(cursorKey).toHaveLength(234);
    expect(PROJECTION_NAME.length + SEPARATOR_LENGTH + cursorKey.length).toBe(
      MAX_PERSISTENCE_ID_LENGTH + 1,
    );

    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);

    const error = await rejectionOf(offsetStore.loadOffset(PROJECTION_NAME, cursorKey));

    expectNamesHalf(error.message, 'tag', cursorKey);
    expect(error.message).toContain('256');
    expect(backend.keys).toEqual([]);
  });

  test('a tag composite at exactly the limit still round-trips', async () => {
    const backend = new RecordingDurableStateStore();
    const offsetStore = new DurableStateOffsetStore(backend);
    const fittingTag = 'y'.repeat(MAX_PERSISTENCE_ID_LENGTH - PROJECTION_NAME.length - SEPARATOR_LENGTH);

    await offsetStore.saveOffset(PROJECTION_NAME, fittingTag, offsetStart);

    expect(await offsetStore.loadOffset(PROJECTION_NAME, fittingTag)).toEqual(offsetStart);
    expect(backend.longestKeyLength()).toBe(MAX_PERSISTENCE_ID_LENGTH);
  });
});

describe('InMemoryOffsetStore — unbounded, deliberately', () => {
  /**
   * The bound belongs to the durable-state *key*, not to the offset-store
   * API, and this is the assertion that keeps a future widening of the rule
   * honest: `InMemoryOffsetStore` keys a `Map`, where 272 characters cost
   * nothing and truncate nowhere.  A fix that bounded the interface instead
   * of the key would break this.
   */
  test('the same pair that the durable-state store refuses still round-trips', async () => {
    const offsetStore = new InMemoryOffsetStore();

    await offsetStore.saveSequence(PROJECTION_NAME, LONG_PERSISTENCE_ID, 7);
    await offsetStore.saveOffset(PROJECTION_NAME, 'tag-'.padEnd(250, 'y'), offsetStart);

    expect(await offsetStore.loadSequence(PROJECTION_NAME, LONG_PERSISTENCE_ID)).toBe(7);
    expect(await offsetStore.loadOffset(PROJECTION_NAME, 'tag-'.padEnd(250, 'y'))).toEqual(offsetStart);
  });
});
