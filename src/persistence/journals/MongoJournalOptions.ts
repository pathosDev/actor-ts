import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsError, OptionsValidator } from '../../util/OptionsValidator.js';
import type { MongoClientLike, MongoConnection } from './MongoClient.js';

/** URL schemes a MongoDB deployment can be reached on. */
export const MONGO_URL_PROTOCOLS = ['mongodb', 'mongodb+srv'] as const;

export interface MongoJournalOptionsType extends MongoConnection {
  /** Events collection name.  Default: `events`.  Its meta collection is `${it}_meta`. */
  readonly eventsCollection?: string;
  /** Create the indexes on first use.  Default: true. */
  readonly autoCreateIndexes?: boolean;
}

/**
 * Fluent builder for {@link MongoJournalOptionsType}:
 *
 *     new MongoJournal(MongoJournalOptions.create()
 *       .withUrl('mongodb://localhost:27017')
 *       .withDatabaseName('app'))
 *
 * Pass a pre-built `withClient(...)` to share ONE client across the journal,
 * snapshot and durable-state stores.
 */
export class MongoJournalOptionsBuilder extends OptionsBuilder<MongoJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MongoJournalOptionsBuilder()`. */
  static create(): MongoJournalOptionsBuilder {
    return new MongoJournalOptionsBuilder();
  }

  /** Connection string — `mongodb://…` or `mongodb+srv://…`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Database name.  Default: `actor_ts`. */
  withDatabaseName(databaseName: string): this {
    return this.set('databaseName', databaseName);
  }

  /** Extra `MongoClient` options — `{ tls, authSource, maxPoolSize, … }`. */
  withClientOptions(clientOptions: Record<string, unknown>): this {
    return this.set('clientOptions', clientOptions);
  }

  /** Pre-built client — bypasses the lazy `mongodb` import; share it across stores. */
  withClient(client: MongoClientLike): this {
    return this.set('client', client);
  }

  /** Events collection name.  Default: `events`. */
  withEventsCollection(eventsCollection: string): this {
    return this.set('eventsCollection', eventsCollection);
  }

  /** Create the indexes on first use.  Default: true. */
  withAutoCreateIndexes(autoCreateIndexes: boolean): this {
    return this.set('autoCreateIndexes', autoCreateIndexes);
  }
}

/**
 * Accepted input for any MongoDB journal constructor: the fluent
 * {@link MongoJournalOptionsBuilder} OR a plain {@link MongoJournalOptionsType} object.
 */
export type MongoJournalOptions = MongoJournalOptionsBuilder | Partial<MongoJournalOptionsType>;
/** Value alias so `MongoJournalOptions.create()` resolves to the builder. */
export const MongoJournalOptions = MongoJournalOptionsBuilder;

/** Validates the connection fields and collection name. */
export class MongoJournalOptionsValidator extends OptionsValidator<MongoJournalOptionsType> {
  constructor() { super('MongoJournalOptions'); }

  protected rules(s: Partial<MongoJournalOptionsType>): void {
    assertMongoUrl('MongoJournalOptions', s.url);
    assertMongoName('MongoJournalOptions', 'databaseName', s.databaseName);
    assertMongoName('MongoJournalOptions', 'eventsCollection', s.eventsCollection);
  }
}

/**
 * Shared URL rule for the MongoDB option families — a standalone function
 * rather than a validator helper, because the families are separate classes over
 * separate option types and the rule is identical for all of them.  Raises the
 * same `OptionsError` shape the base class's `fail` does.
 */
export function assertMongoUrl(optionsName: string, url: string | undefined): void {
  if (url === undefined) return;
  const fail = (reason: string): never => {
    throw new OptionsError(`${optionsName}: url ${reason} (got ${JSON.stringify(url)})`, optionsName, 'url', url);
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('must be a valid URL');
  }
  const protocol = parsed.protocol.replace(/:$/, '');
  if (!MONGO_URL_PROTOCOLS.includes(protocol as (typeof MONGO_URL_PROTOCOLS)[number])) {
    fail(`must use protocol ${MONGO_URL_PROTOCOLS.join(', ')}`);
  }
}

/**
 * Database and collection names are interpolated into no query — the driver
 * sends them as strings — so this is not an injection guard.  It rejects the
 * names MongoDB itself refuses, so a typo fails at wiring time instead of on the
 * first write: empty, containing `$`, a null byte, or (for a database) any of
 * `/\. "` — the characters MongoDB maps onto filesystem paths.
 */
export function assertMongoName(optionsName: string, field: string, name: string | undefined): void {
  if (name === undefined) return;
  const fail = (reason: string): never => {
    throw new OptionsError(`${optionsName}: ${field} ${reason} (got ${JSON.stringify(name)})`, optionsName, field, name);
  };
  if (name.length === 0) fail('must be a non-empty string');
  if (name.includes('\0')) fail('must not contain a null byte');
  if (name.includes('$')) fail('must not contain "$"');
  if (field === 'databaseName' && /[/\\. "]/.test(name)) {
    fail('must not contain any of / \\ . " or a space');
  }
}
