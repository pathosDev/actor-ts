/**
 * In-process fake of the `mongodb` driver API — enough of the document model to
 * exercise `MongoJournal` / `MongoSnapshotStore` / `MongoDurableStateStore` /
 * `MongoQuery` in the fast `bun test` pass without a live server.
 *
 * Unlike the SQL fakes, this one is a small **query engine** rather than a
 * statement matcher: the stores build filter documents, not SQL strings, so
 * matching on shapes would be both uglier and weaker.  It supports exactly the
 * operators the stores use — `$gte`, `$lte`, `$lt`, `$in`, `$max`, `$set` — and
 * throws on anything else, so a new operator cannot slip in untested.
 *
 * Fidelity choices that make the tests meaningful:
 *   - **Unique indexes are enforced.** `createIndex(…, { unique: true })`
 *     registers a constraint, and a violating insert throws with `code = 11000`.
 *     That is the journal's whole concurrency backstop, so a fake that ignored
 *     uniqueness would make the most important test vacuous.
 *   - **`insertMany({ ordered: true })` stops at the first failure** and keeps
 *     what it already inserted, exactly as the driver does — which is what makes
 *     the "a losing writer writes nothing" reasoning testable rather than
 *     asserted.
 *   - Documents are deep-cloned in and out, so a test cannot accidentally share
 *     a reference with the store.
 */
import type {
  MongoClientLike,
  MongoCollectionLike,
  MongoCursorLike,
  MongoDatabaseLike,
  MongoDeleteResult,
  MongoDocument,
  MongoSortSpec,
  MongoUpdateResult,
} from '../../../../src/persistence/journals/MongoClient.js';

class MongoDuplicateKeyError extends Error {
  readonly code = 11000;
  constructor(collection: string, key: string) {
    super(`E11000 duplicate key error collection: ${collection} index: ${key}`);
    this.name = 'MongoServerError';
  }
}

const clone = <T>(value: T): T => structuredClone(value);

/** Compare two values for sort/range purposes; the stores only use numbers and strings. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Does `document` satisfy `filter`?  Supports only the operators the stores emit. */
function matches(document: MongoDocument, filter: MongoDocument): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    const actual = document[field];
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      for (const [operator, operand] of Object.entries(condition as MongoDocument)) {
        switch (operator) {
          case '$gte': if (!(compare(actual, operand) >= 0)) return false; break;
          case '$lte': if (!(compare(actual, operand) <= 0)) return false; break;
          case '$lt': if (!(compare(actual, operand) < 0)) return false; break;
          case '$in': {
            const candidates = operand as unknown[];
            // A multikey field matches when ANY of its entries is in the list.
            const values = Array.isArray(actual) ? actual : [actual];
            if (!values.some((value) => candidates.includes(value))) return false;
            break;
          }
          default:
            throw new Error(`FakeMongoClient: unsupported filter operator ${operator}`);
        }
      }
      continue;
    }
    // Scalar equality — and, as MongoDB does, a scalar matches an array field
    // when it is one of its entries.  That is what makes a tag query work.
    if (Array.isArray(actual)) {
      if (!actual.includes(condition)) return false;
    } else if (actual !== condition) {
      return false;
    }
  }
  return true;
}

class FakeCursor<TDocument extends MongoDocument> implements MongoCursorLike<TDocument> {
  private sortSpec: MongoSortSpec | null = null;
  private limitCount: number | null = null;
  private skipCount = 0;

  constructor(private readonly source: () => TDocument[]) {}

  sort(spec: MongoSortSpec): MongoCursorLike<TDocument> { this.sortSpec = spec; return this; }
  limit(count: number): MongoCursorLike<TDocument> { this.limitCount = count; return this; }
  skip(count: number): MongoCursorLike<TDocument> { this.skipCount = count; return this; }

  async toArray(): Promise<TDocument[]> {
    let rows = this.source();
    if (this.sortSpec) {
      const spec = Object.entries(this.sortSpec);
      rows = [...rows].sort((left, right) => {
        for (const [field, direction] of spec) {
          const ordering = compare(left[field], right[field]) * direction;
          if (ordering !== 0) return ordering;
        }
        return 0;
      });
    }
    if (this.skipCount > 0) rows = rows.slice(this.skipCount);
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows.map(clone);
  }
}

interface UniqueIndex {
  readonly fields: string[];
  readonly name: string;
}

class FakeCollection<TDocument extends MongoDocument> implements MongoCollectionLike<TDocument> {
  private readonly documents: TDocument[] = [];
  private readonly uniqueIndexes: UniqueIndex[] = [];

  constructor(private readonly name: string, private readonly log: string[]) {}

  async createIndex(spec: MongoSortSpec, options?: { unique?: boolean; name?: string }): Promise<string> {
    const fields = Object.keys(spec);
    const name = options?.name ?? `${fields.join('_')}_index`;
    this.log.push(`createIndex ${this.name} ${fields.join(',')}${options?.unique ? ' unique' : ''}`);
    if (options?.unique && !this.uniqueIndexes.some((index) => index.name === name)) {
      this.uniqueIndexes.push({ fields, name });
    }
    return name;
  }

  async insertOne(document: TDocument): Promise<unknown> {
    this.log.push(`insertOne ${this.name}`);
    this.assertUnique(document);
    this.documents.push(clone(document));
    return { acknowledged: true };
  }

  async insertMany(documents: ReadonlyArray<TDocument>, options?: { ordered?: boolean }): Promise<unknown> {
    this.log.push(`insertMany ${this.name} n=${documents.length}`);
    let inserted = 0;
    for (const document of documents) {
      try {
        this.assertUnique(document);
      } catch (e) {
        // `ordered: true` stops here and keeps what was already written — the
        // driver's actual behaviour, and the reason the journal relies on a
        // loser failing on its FIRST document.
        if (options?.ordered !== false) throw e;
        continue;
      }
      this.documents.push(clone(document));
      inserted++;
    }
    return { acknowledged: true, insertedCount: inserted };
  }

  find(filter: MongoDocument): MongoCursorLike<TDocument> {
    return new FakeCursor<TDocument>(() => this.documents.filter((document) => matches(document, filter)));
  }

  async findOne(filter: MongoDocument): Promise<TDocument | null> {
    const found = this.documents.find((document) => matches(document, filter));
    return found ? clone(found) : null;
  }

  async updateOne(
    filter: MongoDocument,
    update: MongoDocument,
    options?: { upsert?: boolean },
  ): Promise<MongoUpdateResult> {
    this.log.push(`updateOne ${this.name} ${Object.keys(update).join(',')}`);
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index >= 0) {
      const current = this.documents[index] as MongoDocument;
      const next = applyUpdate(current, update);
      this.documents[index] = next as TDocument;
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (!options?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    // Upsert seeds the document from the filter's equality terms, as MongoDB
    // does, then applies the update operators on top.
    const seed: MongoDocument = {};
    for (const [field, condition] of Object.entries(filter)) {
      if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) seed[field] = condition;
    }
    const created = applyUpdate(seed, update);
    this.assertUnique(created as TDocument);
    this.documents.push(clone(created) as TDocument);
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
  }

  async deleteMany(filter: MongoDocument): Promise<MongoDeleteResult> {
    this.log.push(`deleteMany ${this.name}`);
    const before = this.documents.length;
    const kept = this.documents.filter((document) => !matches(document, filter));
    this.documents.length = 0;
    this.documents.push(...kept);
    return { deletedCount: before - kept.length };
  }

  async deleteOne(filter: MongoDocument): Promise<MongoDeleteResult> {
    this.log.push(`deleteOne ${this.name}`);
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index < 0) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    return { deletedCount: 1 };
  }

  async distinct(field: string): Promise<unknown[]> {
    return [...new Set(this.documents.map((document) => document[field]))];
  }

  /** Enforce the registered unique indexes, plus `_id`, which is always unique. */
  private assertUnique(document: TDocument): void {
    const constraints: UniqueIndex[] = '_id' in document
      ? [...this.uniqueIndexes, { fields: ['_id'], name: '_id_' }]
      : this.uniqueIndexes;
    for (const index of constraints) {
      const collides = this.documents.some((existing) =>
        index.fields.every((field) => existing[field] === document[field]));
      if (collides) throw new MongoDuplicateKeyError(this.name, index.name);
    }
  }
}

/** Apply `$set` / `$max` — the only update operators the stores emit. */
function applyUpdate(current: MongoDocument, update: MongoDocument): MongoDocument {
  const next: MongoDocument = { ...current };
  for (const [operator, operand] of Object.entries(update)) {
    const fields = operand as MongoDocument;
    switch (operator) {
      case '$set':
        for (const [field, value] of Object.entries(fields)) next[field] = value;
        break;
      case '$max':
        // Writes only when the new value is greater — the monotonic update the
        // journal's high-water mark depends on.
        for (const [field, value] of Object.entries(fields)) {
          const existing = next[field];
          if (existing === undefined || compare(value, existing) > 0) next[field] = value;
        }
        break;
      default:
        throw new Error(`FakeMongoClient: unsupported update operator ${operator}`);
    }
  }
  return next;
}

class FakeDatabase implements MongoDatabaseLike {
  private readonly collections = new Map<string, FakeCollection<MongoDocument>>();

  constructor(private readonly name: string, private readonly log: string[]) {}

  collection<TDocument extends MongoDocument = MongoDocument>(name: string): MongoCollectionLike<TDocument> {
    const existing = this.collections.get(name);
    if (existing) return existing as unknown as MongoCollectionLike<TDocument>;
    const created = new FakeCollection<MongoDocument>(`${this.name}.${name}`, this.log);
    this.collections.set(name, created);
    return created as unknown as MongoCollectionLike<TDocument>;
  }
}

export class FakeMongoClient implements MongoClientLike {
  private readonly databases = new Map<string, FakeDatabase>();
  connectCount = 0;
  closed = false;
  /** Every operation, in order — lets tests assert on what the stores issued. */
  readonly log: string[] = [];

  async connect(): Promise<unknown> {
    this.connectCount++;
    return this;
  }

  db(name = 'test'): MongoDatabaseLike {
    const existing = this.databases.get(name);
    if (existing) return existing;
    const created = new FakeDatabase(name, this.log);
    this.databases.set(name, created);
    return created;
  }

  async close(): Promise<void> { this.closed = true; }
}
