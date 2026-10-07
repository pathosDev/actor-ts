import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { OptionsError, OptionsValidator } from '../../util/OptionsValidator.js';
import { redactUrlCredentials } from '../../util/RedactUrlCredentials.js';
import type { MongoClientLike, MongoConnection } from './MongoClient.js';

/** URL schemes a MongoDB deployment can be reached on. */
export const MONGO_URL_PROTOCOLS = ['mongodb', 'mongodb+srv'] as const;

export interface MongoJournalOptionsType extends MongoConnection, StoreSerializerOptionsBase {
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
export class MongoJournalOptionsBuilder extends StoreSerializerOptionsBuilder<MongoJournalOptionsType> {
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
 *
 * The string is read the way the MongoDB connection-string format lays it out —
 * `scheme://[userinfo@]host[:port][,host[:port]…][/database][?options]` — and
 * not with `new URL(...)`.  A WHATWG URL has one host, so a replica-set seed
 * list without SRV (`mongodb://h1:27017,h2:27017/app?replicaSet=rs`) made that
 * constructor throw on a string the driver accepts, and all three MongoDB stores
 * refused it (#1490).  What is checked is what the driver itself refuses before
 * it dials anything — mongodb 6 and 7, run over each case when this was written
 * — so a url that cannot work fails at construction rather than on the first
 * write:
 *
 *   - the scheme, spelled exactly `mongodb://` or `mongodb+srv://`;
 *   - the userinfo: a non-empty username, then at most one `:` and the
 *     password, any other `@ : / ? # [ ]` percent-encoded, and every escape
 *     valid UTF-8;
 *   - each host: a name, an IPv4 address, a bracketed IPv6 literal or a
 *     percent-encoded socket path, with an optional port from 1 to 65535;
 *   - under `mongodb+srv`, exactly one DNS name and no port, because DNS
 *     supplies the members and their ports.
 *
 * The database and the options are left to the driver, which reads them, and
 * the HOCON readers inspect the options for a TLS switch
 * (`ConnectionStringInspection`).  An `@` past the host list of a url without
 * userinfo is left to the driver as well: it takes everything before that `@`
 * for a userinfo and refuses the url, where the format reads the `@` as part of
 * the database or the options.
 * Where the driver is laxer than the format, the format wins: an empty host
 * entry — `h1,,h2`, or a trailing comma — is refused rather than dialled as
 * localhost, the way the driver dials it, and so is a host holding a space or
 * any other character no host name has.
 */
export function assertMongoUrl(optionsName: string, url: string | undefined): void {
  if (url === undefined) return;
  const fail = (reason: string): never => {
    // `mongodb://user:pass@host/db` is the documented shape, and this message
    // reaches an ERROR log when it fails a store's construction (#590).  A
    // value that is not a string — the type says it is, plain JavaScript need
    // not — may still hold one, so it is rendered first and masked after.
    const redacted = typeof url === 'string'
      ? redactUrlCredentials(url)
      : redactUrlCredentials(OptionsError.renderValue(url));
    throw new OptionsError(
      `${optionsName}: url ${reason} (got ${typeof url === 'string' ? JSON.stringify(redacted) : redacted})`,
      optionsName,
      'url',
      redacted,
    );
  };
  if (typeof url !== 'string') return fail('must be a valid URL');
  const prefix = SCHEME_PREFIX.exec(url);
  if (prefix === null) return fail('must be a valid URL');
  const scheme = prefix[1];
  if (!MONGO_URL_PROTOCOLS.includes(scheme as (typeof MONGO_URL_PROTOCOLS)[number])) {
    return fail(`must use protocol ${MONGO_URL_PROTOCOLS.join(', ')}`);
  }
  const hosts = hostEntriesOf(url.slice(prefix[0].length));
  if (hosts === undefined) return fail('must be a valid URL');
  if (scheme !== 'mongodb+srv') return;
  // The driver's two checks, in its order; an IP literal trips its port check
  // (it looks for a `:`), so it gets a reason of its own here.
  if (hosts.length !== 1) return fail('must name exactly one host when the protocol is mongodb+srv');
  if (hosts[0].startsWith('[')) {
    return fail('must name a DNS name, not an IP literal, when the protocol is mongodb+srv');
  }
  if (hosts[0].includes(':')) return fail('must not name a port when the protocol is mongodb+srv');
}

/** `scheme://` at the start of the string — RFC 3986's scheme grammar, case kept, nothing before it. */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/**
 * A host name, an IPv4 address or a percent-encoded socket path: RFC 3986's
 * reg-name — unreserved characters, percent-escapes, and the sub-delimiters
 * other than the `,` that separates hosts — plus any non-ASCII character, since
 * the format admits an internationalised name.
 */
const HOST_NAME = /^(?:[A-Za-z0-9\-._~!$&'()*+;=]|%[0-9A-Fa-f]{2}|[^\x00-\x7F])+$/;

/** What a username or password must percent-encode — the delimiters the driver refuses there. */
const USERINFO_DELIMITERS = /[:/?#[\]@]/;

/** Where the host list ends: the database's `/`, or the options' `?`, whose slash is optional. */
const HOST_LIST_END = /[/?]/;

/** ASCII tab and newline, which a WHATWG parse drops wherever they stand. */
const TAB_OR_NEWLINE = /[\t\n\r]/g;

/**
 * The host entries of a connection string past its `scheme://`, or `undefined`
 * when the userinfo or any host is malformed.
 *
 * The userinfo, when there is one, ends at the last `@` before the host list.
 * Tab and newline are dropped first, because the driver parses each host as a
 * URL and so drops them too: a url read from a file that ends in a newline
 * names the same hosts as one that does not.
 */
function hostEntriesOf(afterScheme: string): string[] | undefined {
  const end = afterScheme.search(HOST_LIST_END);
  const authority = (end === -1 ? afterScheme : afterScheme.slice(0, end)).replace(TAB_OR_NEWLINE, '');
  const at = authority.lastIndexOf('@');
  if (at !== -1 && !isUserinfo(authority.slice(0, at))) return undefined;
  const entries = authority.slice(at + 1).split(',');
  return entries.every(isHostEntry) ? entries : undefined;
}

/** `username[:password]` as the driver takes it: a username, and no unescaped delimiter in either half. */
function isUserinfo(userinfo: string): boolean {
  const colon = userinfo.indexOf(':');
  const username = colon === -1 ? userinfo : userinfo.slice(0, colon);
  const password = colon === -1 ? '' : userinfo.slice(colon + 1);
  return username !== ''
    && !USERINFO_DELIMITERS.test(username)
    && !USERINFO_DELIMITERS.test(password)
    && decodes(username)
    && decodes(password);
}

/** One `host[:port]` of the list: a name or a bracketed IPv6 literal, then an optional port. */
function isHostEntry(entry: string): boolean {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close === -1) return false;
    const afterLiteral = entry.slice(close + 1);
    return isIpv6Literal(entry.slice(0, close + 1))
      && (afterLiteral === '' || (afterLiteral.startsWith(':') && isPort(afterLiteral.slice(1))));
  }
  const colon = entry.indexOf(':');
  const name = colon === -1 ? entry : entry.slice(0, colon);
  return HOST_NAME.test(name) && decodes(name) && (colon === -1 || isPort(entry.slice(colon + 1)));
}

/** Empty, which the driver reads as its default, or a decimal from 1 to 65535 — the driver refuses zero. */
function isPort(port: string): boolean {
  if (port === '') return true;
  if (!/^[0-9]+$/.test(port)) return false;
  const value = Number(port);
  return value >= 1 && value <= 65_535;
}

/**
 * A bracketed IPv6 literal, judged by the WHATWG host parser the driver judges
 * it by — on the literal alone, which is one host and so parses.
 *
 * The verdict is this runtime's, on purpose: Bun 1.4.2 refuses a few literals
 * with an IPv4 tail (`[1::3:4:5:1.2.3.4]`) that Node and Deno accept, and the
 * driver, parsing with the same `URL`, cannot dial them there either.  A
 * hand-written grammar would agree across runtimes and disagree with the
 * driver on the one where it runs.
 */
function isIpv6Literal(bracketed: string): boolean {
  try {
    new URL(`http://${bracketed}/`);
    return true;
  } catch {
    return false;
  }
}

/** Whether every percent-escape in `text` decodes, as the driver decodes the userinfo and each host. */
function decodes(text: string): boolean {
  try {
    decodeURIComponent(text);
    return true;
  } catch {
    return false;
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
