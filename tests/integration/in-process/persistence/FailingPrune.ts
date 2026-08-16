/**
 * Fault injection for the snapshot contract's prune-failure scenario (#393).
 *
 * The rule under test — a failing retention pass must not fail an otherwise
 * successful `save` — can only be observed by breaking the prune while
 * leaving the write intact.  None of the eight persistence fakes has a
 * fault-injection seam, so rather than adding a bespoke flag to each one,
 * these wrappers proxy the fake and reject a single method.
 *
 * Every store's prune issues an operation the write path does not, which is
 * what makes a one-method proxy precise enough:
 *
 *   - relational — the prune is the only statement carrying `NOT IN`;
 *   - SQLite     — same statement, reached through a prepared handle;
 *   - Cassandra  — the write is an INSERT, the prune a ranged DELETE;
 *   - Mongo      — the write is `updateOne`, the prune `deleteMany`;
 *   - DynamoDB   — the write is `putItem`, the prune `batchWriteItem`.
 *
 * A proxy rather than a copy on purpose: the fakes hold their rows in
 * private fields, so `{ ...fake }` would hand the store an object whose
 * methods operate on a detached bag of state.  `Reflect` forwards to the
 * real instance and everything else behaves normally.
 *
 * Every pass-through method is **bound to the real target**.  Without that,
 * `proxy.exec(...)` invokes the method with the proxy as `this`, and a class
 * using genuine `#private` fields — `bun:sqlite`'s `Database` and
 * `Statement`, as opposed to the fakes' TypeScript `private`, which is only
 * a plain property — throws "Cannot access invalid private field" before it
 * reaches any of the logic under test.
 */
import { getSqliteDriver, type SqliteDb, type SqliteDriver, type SqliteStatement } from '../../../../src/runtime/sqlite/index.js';

/** Marker the scenario's failures carry, so an unexpected one is obvious. */
export const INJECTED_PRUNE_FAILURE = 'injected prune failure';

/**
 * Reject calls to `method` for which `matches` holds; forward everything
 * else.  `matches` defaults to "always", which is what the stores whose
 * prune has a method all to itself need.
 */
export function rejectMethod<T extends object>(
  target: T,
  method: string,
  matches: (args: readonly unknown[]) => boolean = () => true,
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value !== 'function') return value;
      const inner = value as (...a: unknown[]) => unknown;
      if (property !== method) return inner.bind(object);
      return (...args: unknown[]): unknown => {
        if (matches(args)) throw new Error(`${INJECTED_PRUNE_FAILURE}: ${method}`);
        return inner.apply(object, args);
      };
    },
  });
}

/** True for the relational retention statement — the only one using `NOT IN`. */
const isPruneSql = (args: readonly unknown[]): boolean =>
  typeof args[0] === 'string' && /NOT IN/i.test(args[0]);

/** Relational pools / clients: the prune is the `NOT IN` delete. */
export function poolWithFailingPrune<T extends object>(pool: T): T {
  return rejectMethod(pool, 'query', isPruneSql);
}

/** Cassandra: the write is an INSERT, the prune the ranged DELETE. */
export function cassandraClientWithFailingPrune<T extends object>(client: T): T {
  return rejectMethod(
    client,
    'execute',
    (args) => typeof args[0] === 'string' && /^\s*DELETE/i.test(args[0]) && /sequence_nr </i.test(args[0]),
  );
}

/** DynamoDB: the write is `putItem`, the prune's delete is a batch write. */
export function dynamoDbWithFailingPrune<T extends object>(operations: T): T {
  return rejectMethod(operations, 'batchWriteItem');
}

/**
 * Mongo: `deleteMany` is the prune, but it lives two hops down
 * (`client.db().collection()`), so each hop is proxied in turn.
 */
export function mongoClientWithFailingPrune<T extends object>(client: T): T {
  return new Proxy(client, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value !== 'function') return value;
      const inner = value as (...a: unknown[]) => unknown;
      if (property !== 'db') return inner.bind(object);
      return (...args: unknown[]): unknown => {
        const database = inner.apply(object, args) as object;
        return new Proxy(database, {
          get(db, dbProperty) {
            const dbValue = Reflect.get(db, dbProperty);
            if (typeof dbValue !== 'function') return dbValue;
            const dbInner = dbValue as (...a: unknown[]) => unknown;
            if (dbProperty !== 'collection') return dbInner.bind(db);
            return (...collectionArgs: unknown[]): unknown =>
              rejectMethod(dbInner.apply(db, collectionArgs) as object, 'deleteMany');
          },
        });
      };
    },
  });
}

/**
 * SQLite drives a real driver rather than a fake, so the seam is one level
 * lower: the prune's prepared statement is the one whose SQL carries
 * `NOT IN`, and only its `run` is rejected.
 */
export async function sqliteDriverWithFailingPrune(): Promise<SqliteDriver> {
  const driver = await getSqliteDriver();
  return new Proxy(driver, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value !== 'function') return value;
      const inner = value as (...a: unknown[]) => unknown;
      if (property !== 'open') return inner.bind(object);
      return (...args: unknown[]): SqliteDb => {
        const database = inner.apply(object, args) as SqliteDb;
        return new Proxy(database, {
          get(db, dbProperty) {
            const dbValue = Reflect.get(db, dbProperty);
            if (typeof dbValue !== 'function') return dbValue;
            const dbInner = dbValue as (...a: unknown[]) => unknown;
            if (dbProperty !== 'prepare') return dbInner.bind(db);
            return (sql: string): SqliteStatement => {
              const statement = dbInner.call(db, sql) as SqliteStatement;
              return /NOT IN/i.test(sql) ? rejectMethod(statement, 'run') : statement;
            };
          },
        });
      };
    },
  });
}
