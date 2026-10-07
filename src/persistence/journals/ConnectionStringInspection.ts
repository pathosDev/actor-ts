import type { Config } from '../../config/Config.js';
import { ConfigError } from '../../config/Config.js';
import { readStoreString } from '../StoreConfig.js';

/**
 * Refuse a connection string read from configuration when it switches TLS
 * certificate verification off (#1490).
 *
 * Three of the persistence drivers read a verification switch out of the
 * connection string itself, so the `url` leaf of their HOCON blocks is a
 * channel through which a configuration file can turn verification off — and
 * until this module it did, verbatim: `sslmode=no-verify` reached
 * node-postgres, `TrustServerCertificate=true` reached node-mssql and
 * `tlsInsecure=true` reached the MongoDB driver.  Encryption without
 * verification authenticates nobody: anything on the path to the database can
 * present its own certificate and read or rewrite the journal, which is the
 * application's system of record.
 *
 * The rule is the one the CORS wildcard follows (#878): a value that widens
 * what is trusted has no path through HOCON and stays available in code, where
 * the decision is visible in review.  So the HOCON readers refuse such a url
 * with a `ConfigError`, and a url set with `withUrl(...)` is never inspected.
 * The refusal is strict: a block's url is read — and refused — even when code
 * supplies its own url or pool, because a file that carries the switch is one
 * deleted line of code away from it taking effect.
 *
 * ### The switches
 *
 * Read from the driver sources the peer ranges admit — pg 8.23 over
 * pg-connection-string 2.14, mssql 12.7 over @tediousjs/connection-string 1.1,
 * mongodb 6.21 and 7.6 — and confirmed by running those parsers, not their
 * documentation, when this module was written.  A re-read is due whenever a
 * peer range moves:
 *
 * | Driver | Switch | What goes unchecked |
 * | --- | --- | --- |
 * | node-postgres | `sslmode=no-verify` | the certificate |
 * | node-postgres | `ssl=no-verify` — read by `pg` itself, not the parser | the certificate |
 * | node-postgres | `sslmode=prefer` under `uselibpqcompat=true` | the certificate |
 * | node-postgres | `sslmode=require` under `uselibpqcompat=true` | the certificate; with `sslrootcert`, the hostname |
 * | node-postgres | `sslmode=verify-ca` under `uselibpqcompat=true` | the hostname |
 * | node-mssql | `TrustServerCertificate` set to anything but `false`, `no`, `0` or empty | the certificate |
 * | mongodb | `tlsInsecure`, `tlsAllowInvalidCertificates` set to anything but `false` | the certificate |
 * | mongodb | `tlsAllowInvalidHostnames` set to anything but `false` | the hostname |
 *
 * Without `uselibpqcompat`, `prefer`, `require` and `verify-ca` are aliases of
 * `verify-full` in pg 8 and stay allowed; the next major release of the
 * parser announces libpq's weaker meanings for them, and moving the peer range
 * to it means revisiting this table.
 *
 * ### Read the way the driver reads it, then a little more loosely
 *
 * Each string is taken apart the way its driver takes it apart — the WHATWG
 * query of a URL for Postgres and MongoDB, the ADO.NET grammar for SQL Server —
 * because a matcher that reads a different string than the driver is one a
 * spelling walks past: `no%2Dverify`, a tab the URL parser removes, a quoted
 * `" false"` that node-mssql reads as *true*.  On top of that parse the match
 * is looser than any driver in one direction only: case and surrounding
 * whitespace are ignored on keys and values, and every occurrence of a key
 * counts rather than the last.  A spelling the pinned driver happens to ignore
 * is still a file that says *verification off*, and the next release of the
 * driver may honour it.  The value the switch is compared against is never
 * loosened the other way: SQL Server's `TrustServerCertificate` is refused
 * unless the driver itself would read the value as false.
 *
 * ### What is not refused
 *
 * - **Plaintext** — `sslmode=disable`, `Encrypt=false`, `tls=false`.  No TLS is
 *   a different decision from TLS that authenticates nobody, it is visible in
 *   the url for what it is, and it stays allowed.
 * - **MariaDB.**  The connector coerces its url's `ssl` to a boolean (mariadb
 *   3.5 `connection-options.js:309`), and `ssl=true` verifies the chain
 *   against the trust store, so its url has no verification-off switch to
 *   refuse.
 * - **Anything that is not the url** — `poolConfig` and `clientOptions` in
 *   code, and node-postgres' own fallback to the `PGSSLMODE` environment
 *   variable when the url names no `sslmode`.
 */

/** The drivers whose connection string carries a verification switch. */
export type InspectedDriver = 'postgres' | 'mssql' | 'mongodb';

/**
 * What a switch stops the driver checking.  `certificate` leaves the server
 * unauthenticated altogether; `hostname` still checks the chain but not the
 * name on it, so a certificate the same authority issued for any other host
 * passes — which for a public authority means anyone's.
 */
export type VerificationLoss = 'certificate' | 'hostname';

/** One verification-off switch found in a connection string. */
export type VerificationOffSwitch = {
  /**
   * The switch as `key=value`: the key as the string spells it, the value as
   * the driver reads it.  Never the value as written, which for a malformed
   * SQL Server string can run on into the next key — a password included.
   */
  readonly spelling: string;
  readonly loses: VerificationLoss;
};

/** One `key=value` pair of a connection string, decoded the way its driver decodes it. */
export type ConnectionStringPair = {
  readonly key: string;
  readonly value: string;
};

/** Case and surrounding whitespace ignored — the loosening every comparison here shares. */
const normalised = (text: string): string => text.trim().toLowerCase();

/**
 * The two input normalisations of WHATWG URL parsing, which a URL-shaped
 * connection string goes through before its query is read: leading and
 * trailing C0 controls and spaces are stripped, and ASCII tab and newline are
 * removed wherever they stand.  Skipping them would let HOCON's `\t` or
 * `\u0001` escapes hide a switch from this module while the driver still
 * sees it.
 */
const asUrlParserReadsIt = (url: string): string =>
  url.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');

/**
 * The query pairs of a URL-shaped connection string, decoded as
 * `URLSearchParams` decodes them — which is what pg-connection-string and
 * mongodb-connection-string-url both do with `new URL(...).searchParams`.
 *
 * Not `new URL(url)` itself: a MongoDB seed list (`h1:27017,h2:27017`) is not a
 * valid WHATWG host, so the constructor throws on a string the driver accepts.
 * The query is everything after the first `?` up to a `#`.  Where the two
 * differ — a `?` inside a fragment, say — this reads more than the driver,
 * never less.
 */
export function urlQueryPairs(url: string): ConnectionStringPair[] {
  const text = asUrlParserReadsIt(url);
  const queryStart = text.indexOf('?');
  if (queryStart < 0) return [];
  const fragmentStart = text.indexOf('#', queryStart);
  const query = text.slice(queryStart + 1, fragmentStart < 0 ? text.length : fragmentStart);
  return [...new URLSearchParams(query)].map(([key, value]) => ({ key, value }));
}

/** The quotes an ADO.NET value may open with, mapped to the character that closes each.  Keys are never quoted. */
const ADO_NET_VALUE_QUOTES: ReadonlyMap<string, string> = new Map([['"', '"'], ["'", "'"], ['{', '}']]);

/**
 * The pairs of an ADO.NET connection string, in order and with repeats —
 * @tediousjs/connection-string 1.1's grammar, which is what node-mssql hands a
 * string `url` to.
 *
 * A port rather than an approximation, because SQL Server's switch is decided
 * by details a split on `;` gets wrong: `;;` and `==` escape a literal, a value
 * may be quoted with `"`, `'` or braces with the closing quote doubled to
 * escape it, a quoted value is *not* trimmed (so `" false"` is not false), and
 * a `;` that opens a value is part of it.  Where the driver throws on a
 * malformed string this returns the pairs read so far: the driver connects to
 * nothing then, and anything the prefix carried is still refused.
 *
 * Keys keep the string's own case so a refusal can quote them; the driver
 * lowercases them, and so does every comparison.
 */
export function adoNetPairs(connectionString: string): ConnectionStringPair[] {
  const pairs: ConnectionStringPair[] = [];
  let readingKey = true;
  let started = false;
  let closed = false;
  let closingQuote = '';
  let buffer = '';
  let key = '';
  const collect = (): void => {
    const token = closingQuote === '' ? buffer.trim() : buffer;
    if (readingKey) key = token;
    else pairs.push({ key, value: token });
    readingKey = !readingKey;
    started = false;
    closed = false;
    closingQuote = '';
    buffer = '';
  };
  for (let index = 0; index < connectionString.length; index += 1) {
    const character = connectionString.charAt(index);
    const terminator = readingKey ? '=' : ';';
    if (closed) {
      // Only whitespace may stand between a closing quote and the terminator;
      // the driver throws on anything else, so nothing past it reaches a server.
      if (character === terminator) collect();
      else if (character.trim() !== '') return pairs;
      continue;
    }
    if (!started) {
      if (character.trim() === '') continue;
      started = true;
      const closing = readingKey ? undefined : ADO_NET_VALUE_QUOTES.get(character);
      if (closing === undefined) buffer += character;
      else closingQuote = closing;
      continue;
    }
    const delimiter = closingQuote === '' ? terminator : closingQuote;
    if (character !== delimiter) {
      buffer += character;
    } else if (connectionString.charAt(index + 1) === character) {
      buffer += character;
      index += 1;
    } else if (closingQuote === '') {
      collect();
    } else {
      closed = true;
    }
  }
  if (closingQuote !== '' && !closed) return pairs;
  collect();
  return pairs;
}

/**
 * Under `uselibpqcompat=true` pg-connection-string gives `sslmode` libpq's
 * meanings, three of which stop short of verifying the server (index.js
 * 106-134).  `require` with a root certificate is libpq's `verify-ca`, so the
 * hostname is what it loses then; {@link postgresSwitches} handles that case.
 */
const LIBPQ_SSLMODE_LOSSES: ReadonlyMap<string, VerificationLoss> = new Map([
  ['prefer', 'certificate'],
  ['require', 'certificate'],
  ['verify-ca', 'hostname'],
]);

/**
 * node-postgres' switches.  `sslmode=no-verify` is pg-connection-string's
 * own mode (index.js:153); `ssl=no-verify` is read by `pg`'s
 * `ConnectionParameters` after the parser (connection-parameters.js:92-95)
 * and has the same effect whenever no other `ssl*` parameter displaces it.
 * `no-verify` is refused in either key whatever else the string says,
 * `uselibpqcompat` included — strict, as everywhere here.
 */
function postgresSwitches(url: string): VerificationOffSwitch[] {
  const pairs = urlQueryPairs(url);
  const libpqMeanings = pairs.some(
    (pair) => normalised(pair.key) === 'uselibpqcompat' && normalised(pair.value) === 'true',
  );
  // Exactly the parser's own test (`if (config.sslrootcert)`), since this only
  // decides which of two losses to name, not whether to refuse.
  const rootCertificate = pairs.some((pair) => pair.key === 'sslrootcert' && pair.value !== '');
  const found: VerificationOffSwitch[] = [];
  for (const pair of pairs) {
    const key = normalised(pair.key);
    const value = normalised(pair.value);
    if ((key === 'sslmode' || key === 'ssl') && value === 'no-verify') {
      found.push({ spelling: `${pair.key.trim()}=${value}`, loses: 'certificate' });
      continue;
    }
    const libpqLoss = key === 'sslmode' && libpqMeanings ? LIBPQ_SSLMODE_LOSSES.get(value) : undefined;
    if (libpqLoss !== undefined) {
      found.push({
        spelling: `uselibpqcompat=true&${pair.key.trim()}=${value}`,
        loses: value === 'require' && rootCertificate ? 'hostname' : libpqLoss,
      });
    }
  }
  return found;
}

/**
 * The values @tediousjs/connection-string reads as false for a boolean key,
 * compared lowercase; every other value — `yes`, `1`, `on`, `" false"` with its
 * space — is true (connection-string.js:32-33, which node-mssql's
 * connection-pool.js:315 copies into `options` unchanged).
 */
const ADO_NET_FALSE_VALUES: ReadonlySet<string> = new Set(['false', 'no', '0', '']);

/** A URL rather than an ADO.NET string: a scheme, then `//`. */
const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * node-mssql's one switch, `TrustServerCertificate`, which tedious turns
 * straight into an unverified `tls.connect`.  The key is matched with its
 * inner whitespace removed as well, so .NET's `Trust Server Certificate`
 * spelling is refused although node-mssql ignores it.
 *
 * The query of an `mssql://` url is searched too.  node-mssql has parsed only
 * the ADO.NET grammar since its 8.0, so a url in that form reaches no server
 * at all — but this framework's own documentation names the form for the
 * `url` leaf, and a switch in its query is a file saying *verification off*
 * whichever grammar a release happens to read.  Only a string that starts
 * with a scheme is read that way, so a `?` inside an ADO.NET password is
 * still just the password.
 */
function msSqlSwitches(connectionString: string): VerificationOffSwitch[] {
  const pairs = adoNetPairs(connectionString);
  if (URL_SHAPED.test(connectionString.trim())) pairs.push(...urlQueryPairs(connectionString));
  return pairs
    .filter((pair) => normalised(pair.key).replace(/\s+/g, '') === 'trustservercertificate')
    .filter((pair) => !ADO_NET_FALSE_VALUES.has(pair.value.toLowerCase()))
    .map((pair) => ({ spelling: `${pair.key}=true`, loses: 'certificate' }));
}

/**
 * The MongoDB driver's three switches (connection_string.js:932-972 in 7.6,
 * 905-946 in 6.21), keyed lowercase because the driver matches option names
 * case-insensitively.  A `Map`, so a key such as `constructor` cannot reach a
 * prototype property.
 */
const MONGO_SWITCH_LOSSES: ReadonlyMap<string, VerificationLoss> = new Map([
  ['tlsinsecure', 'certificate'],
  ['tlsallowinvalidcertificates', 'certificate'],
  ['tlsallowinvalidhostnames', 'hostname'],
]);

/**
 * The MongoDB switches.  The driver accepts exactly `true` and `false` and
 * throws on anything else, so refusing every value but `false` refuses nothing
 * the driver would have connected with.  The legacy `ssl*` spellings of these
 * options are not in the list because both driver majors refuse them as
 * unsupported.
 */
function mongoSwitches(url: string): VerificationOffSwitch[] {
  const found: VerificationOffSwitch[] = [];
  for (const pair of urlQueryPairs(url)) {
    const loss = MONGO_SWITCH_LOSSES.get(normalised(pair.key));
    if (loss !== undefined && normalised(pair.value) !== 'false') {
      found.push({ spelling: `${pair.key.trim()}=true`, loses: loss });
    }
  }
  return found;
}

const SWITCH_FINDERS: Readonly<Record<InspectedDriver, (url: string) => VerificationOffSwitch[]>> = {
  postgres: postgresSwitches,
  mssql: msSqlSwitches,
  mongodb: mongoSwitches,
};

/** Every verification-off switch `url` carries for `driver`, in the order they appear. */
export function findVerificationOffSwitches(
  driver: InspectedDriver,
  url: string,
): ReadonlyArray<VerificationOffSwitch> {
  return SWITCH_FINDERS[driver](url);
}

/**
 * What to do instead, per driver.  SQL Server's is the awkward one: a
 * connection string has no key for a CA at all, so a server behind a private
 * CA cannot be reached from configuration alone today.
 */
const REMEDIES: Readonly<Record<InspectedDriver, string>> = {
  postgres: 'use sslmode=verify-full, adding sslrootcert=<CA file> when a private CA signed the server certificate',
  mssql: 'drop the switch so the driver verifies the server certificate; a connection string has no key '
    + 'for a CA, so a private CA is given in code with withPoolConfig(...)',
  mongodb: 'drop the switch so the driver verifies the server certificate, naming a private CA with '
    + 'tlsCAFile=<CA file>',
};

const LOSS_DESCRIPTIONS: Readonly<Record<VerificationLoss, string>> = {
  certificate: 'the server certificate goes unverified',
  hostname: 'the name on the server certificate goes unchecked',
};

/**
 * Throw a `ConfigError` when `url`, read from the HOCON leaf at `keyPath`,
 * switches TLS verification off for `driver`.
 *
 * The message names the leaf and the switch and never the url, which carries
 * credentials as often as not.
 */
export function refuseVerificationOffUrl(driver: InspectedDriver, url: string, keyPath: string): void {
  const switches = findVerificationOffSwitches(driver, url);
  if (switches.length === 0) return;
  const named = switches
    .map((found) => `"${found.spelling}" (${LOSS_DESCRIPTIONS[found.loses]})`)
    .join(', ');
  throw new ConfigError(
    `Config at "${keyPath}" switches TLS verification off: ${named}.  A connection string read `
    + `from configuration may not — ${REMEDIES[driver]}.  To accept an unverified server on `
    + 'purpose, remove the url from the configuration and set it in code with withUrl(...), '
    + 'which is not inspected.  See https://actor-ts.dev/operations/security/tls-everywhere/.',
  );
}

/**
 * Read a store's `url` leaf as `readStoreString` does — `""` is unset — and
 * refuse it when it switches TLS verification off for `driver`.  The HOCON
 * readers of the three drivers with such a switch use this in place of
 * `readStoreString`; MariaDB's does not, its url having no switch to refuse.
 */
export function readStoreUrl(config: Config, path: string, driver: InspectedDriver): string | undefined {
  const url = readStoreString(config, path);
  if (url !== undefined) refuseVerificationOffUrl(driver, url, path);
  return url;
}
