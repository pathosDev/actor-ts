/**
 * The two credential-safe URL renderings (#590, #592).
 *
 * The interesting half of this suite is not "does it mask a password" — it is
 * the no-op side.  These functions run on an error path, unconditionally, over
 * values that are not necessarily URLs at all (`':memory:'`, `'file:local.db'`,
 * `'not a url'`), and a redactor that mangles those would replace a real
 * diagnostic with a worse one.
 */
import { describe, expect, test } from 'bun:test';
import { redactUrlCredentials, redactedUrlLabel } from '../../../src/util/RedactUrlCredentials.js';

describe('redactUrlCredentials', () => {
  // Mutable tuples on purpose: with `readonly` elements Bun's `test.each`
  // overloads degrade the callback parameters to `unknown`.
  const masked: ReadonlyArray<[string, string]> = [
    ['mongodb://user:pass@host:27017/db', 'mongodb://***@host:27017/db'],
    ['mongodb+srv://user:pass@cluster.example.net/db', 'mongodb+srv://***@cluster.example.net/db'],
    ['amqp://guest:guest@rabbit:5672/vhost', 'amqp://***@rabbit:5672/vhost'],
    ['redis://:s3cr3t@cache:6379', 'redis://***@cache:6379'],
    ['rediss://user@cache:6380/0', 'rediss://***@cache:6380/0'],
    ['mqtt://user:pass@broker:1883', 'mqtt://***@broker:1883'],
    ['libsql://token@db.turso.io', 'libsql://***@db.turso.io'],
    ['wss://user:pass@example.com/ws?token=abc', 'wss://***@example.com/ws?token=abc'],
    // The LAST `@` inside the authority delimits the userinfo, which is how
    // WHATWG splits it when the password itself contains an unescaped one.
    ['amqp://user:p@ss@rabbit:5672', 'amqp://***@rabbit:5672'],
    // A joined server list — NatsActor builds one of these.
    ['nats://a:b@h1:4222,nats://c:d@h2:4222', 'nats://***@h1:4222,nats://***@h2:4222'],
  ];

  test.each([...masked])('masks the userinfo of %p', (input, expected) => {
    expect(redactUrlCredentials(input)).toBe(expected);
  });

  test('leaves no fragment of the credential behind', () => {
    const redacted = redactUrlCredentials('mongodb://admin:hunter2@host:27017/db');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('admin');
  });

  // A pure no-op means byte-identical: no normalisation, no trailing slash, no
  // lowercased host — the operator has to recognise the value they mistyped.
  const untouched: readonly string[] = [
    ':memory:',
    'file:local.db',
    'file:/tmp/actor-ts.db',
    'not a url',
    '',
    '<unknown>',
    'mongodb://Host:27017/DB',
    'https://EXAMPLE.com',
    'wss://example.com/ws?token=abc',
    // An `@` outside the authority is not userinfo.
    'redis://cache:6379/a@b',
    // No `//` authority at all.
    'mailto:ops@example.com',
    'postgres',
  ];

  test.each([...untouched])('is byte-identical on %p', (input) => {
    expect(redactUrlCredentials(input)).toBe(input);
  });

  test('is idempotent', () => {
    const once = redactUrlCredentials('amqp://user:pass@rabbit:5672/vhost');
    expect(redactUrlCredentials(once)).toBe(once);
  });

  test('the guard parsed something — both tables are non-trivial', () => {
    expect(masked.length).toBeGreaterThanOrEqual(10);
    expect(untouched.length).toBeGreaterThanOrEqual(10);
  });
});

describe('redactedUrlLabel', () => {
  const labelled: ReadonlyArray<[string, string]> = [
    ['wss://user:pass@example.com/ws?token=abc', 'wss://example.com/ws'],
    ['ws://127.0.0.1:8080/ws', 'ws://127.0.0.1:8080/ws'],
    ['wss://example.com/ws#frag', 'wss://example.com/ws'],
    ['https://user@api.example.com/v1/things?page=2', 'https://api.example.com/v1/things'],
    ['mqtt://user:pass@broker:1883', 'mqtt://broker:1883'],
  ];

  test.each([...labelled])('reduces %p to its loggable identity', (input, expected) => {
    expect(redactedUrlLabel(input)).toBe(expected);
  });

  test('keeps the path, which is what tells two connections apart', () => {
    expect(redactedUrlLabel('wss://h/ws/orders?token=a')).not.toBe(redactedUrlLabel('wss://h/ws/audit?token=a'));
  });

  test('drops a query-string token', () => {
    expect(redactedUrlLabel('wss://example.com/ws?access_token=s3cr3t')).not.toContain('s3cr3t');
  });

  test('is total on a value that is not a URL', () => {
    expect(redactedUrlLabel('not a url')).toBe('not a url');
    expect(redactedUrlLabel('<unknown>')).toBe('<unknown>');
    expect(redactedUrlLabel(':memory:')).toBe(':memory:');
  });

  test('still masks userinfo on the unparseable fallback path', () => {
    // Not a valid URL (a space in the authority), so `new URL` throws and the
    // regex path has to carry the redaction on its own.
    expect(redactedUrlLabel('amqp://user:pass@ra bbit:5672?x=1')).toBe('amqp://***@ra bbit:5672');
  });
});
