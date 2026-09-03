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
import { redactErrorCredentials, redactUrlCredentials, redactedUrlLabel } from '../../../src/util/RedactUrlCredentials.js';

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
    // -- scheme grammar, pinned because the scan that finds it was rewritten
    //    to be linear (#1198) and must still accept exactly RFC 3986's
    //    `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
    ['HTTPS://user:pass@example.com', 'HTTPS://***@example.com'],
    ['a+b-c.d://user@host', 'a+b-c.d://***@host'],
    // The scheme starts at the first LETTER of the run, so the digits ahead
    // of it are outside the match and survive untouched.
    ['x1://user@host', 'x1://***@host'],
    ['1abc://user@host', '1abc://***@host'],
    // No length cap in RFC 3986, and none imposed here.
    [`${'s'.repeat(300)}://user:pass@host`, `${'s'.repeat(300)}://***@host`],
    // An empty scheme *tail*: one letter is the whole scheme.
    ['a://user@host', 'a://***@host'],
    // `[^/?#]` cannot cross the second `://`, so the inner URL is the one
    // with an authority to mask.
    ['a://b://c@d', 'a://b://***@d'],
    // Userinfo with no host after it.
    ['redis://token@', 'redis://***@'],
    // A second URL later in the line still gets its own pass.
    ['see amqp://u:p@h/vhost now', 'see amqp://***@h/vhost now'],
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
    // -- boundaries of the scan, pinned alongside the linear rewrite (#1198).
    // No scheme in front of the `://`, so there is no URL here to redact.
    '://user@host',
    '//user@host',
    '1://user@host',
    '+://user@host',
    // `?` and `#` close the authority: an `@` past either is query or
    // fragment, not userinfo.
    'https://host?u@p',
    'https://host#u@p',
    // A run of scheme characters that never reaches a `://` — the shape that
    // used to cost 484 ms at 16 KiB.
    'a'.repeat(64),
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

  /**
   * The differential half of the #1198 rewrite.
   *
   * `redactUrlCredentials` is exported from `src/index.ts`, so its output is
   * public API: an input that was redacted before has to be redacted
   * identically after, and one that passed through has to keep passing
   * through.  The tables above pin the cases a human thought of; this pins
   * the ones nobody did, by running the **original regex** — kept here
   * verbatim as an oracle — over inputs built from the alphabet that
   * decides the match, and demanding byte equality.
   *
   * Committed *before* the rewrite on purpose.  Against the original
   * implementation it is tautological, and that is the point: it fixes the
   * behaviour at the version everyone already has, so the diff that follows
   * cannot move it unnoticed.  The generator is seeded, so a failure names a
   * reproducible input rather than a number that never comes back.
   */
  describe('behaviour is byte-identical to the original regex (#1198)', () => {
    const ORIGINAL_URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/g;

    function originalRedaction(value: string): string {
      return value.replace(ORIGINAL_URL_USERINFO, '$1***@');
    }

    /**
     * The pattern's vocabulary, drawn as **tokens** rather than characters:
     * `://` has to appear as a unit or a random draw over single characters
     * almost never produces a URL at all, and a corpus of near-misses tests
     * only the no-op path.
     */
    const TOKENS = ['://', '//', '@', 'a', 'A', 'ab', '1', '+', '.', '-', ':', '/', '?', '#', 'x', ' '];

    /** Scheme-legal characters — what `[A-Za-z0-9+.-]*` accepts. */
    const SCHEME_TOKENS = ['a', 'A', 'ab', '1', '+', '.', '-', 'x'];

    /** Authority-legal characters — everything `[^/?#]` accepts. */
    const USERINFO_TOKENS = ['a', 'A', 'ab', '1', '+', '.', '-', ':', '@', 'x', ' '];

    /** xorshift32 — a seeded generator, so a counter-example stays reachable. */
    function randomSequence(seed: number): () => number {
      let state = seed;
      return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x1_0000_0000;
      };
    }

    /**
     * Half free-form token soup, half a `…://…@…` skeleton filled with the
     * same soup.  Unbiased draws almost never satisfy the pattern's ordering
     * constraint, so a pure soup corpus would exercise the no-op path 99 %
     * of the time; the skeleton puts the delimiters in the right order and
     * lets the soup break them again — a `/` landing in the authority, a
     * scheme that starts with a digit, a second `://` inside the userinfo.
     */
    function generateInput(next: () => number): string {
      const draw = (pool: readonly string[], tokens: number): string => {
        let out = '';
        for (let i = 0; i < tokens; i++) out += pool[Math.floor(next() * pool.length)];
        return out;
      };
      if (next() < 0.4) return draw(TOKENS, 1 + Math.floor(next() * 12));
      // Each slot is filled from its own legal pool most of the time and from
      // the full one otherwise, so the corpus holds both URLs that redact and
      // URLs one stray `/` away from not redacting.
      const scheme = next() < 0.75
        ? `a${draw(SCHEME_TOKENS, Math.floor(next() * 3))}`
        : draw(TOKENS, 1 + Math.floor(next() * 2));
      const userinfo = next() < 0.75
        ? draw(USERINFO_TOKENS, 1 + Math.floor(next() * 3))
        : draw(TOKENS, 1 + Math.floor(next() * 3));
      return `${scheme}://${userinfo}@${draw(TOKENS, 1 + Math.floor(next() * 3))}`;
    }

    test('agrees with the original on 20 000 generated inputs', () => {
      const next = randomSequence(0x1198_2026);
      const disagreements: string[] = [];
      let redacted = 0;
      for (let i = 0; i < 20_000; i++) {
        const input = generateInput(next);
        const expected = originalRedaction(input);
        if (expected !== input) redacted++;
        if (redactUrlCredentials(input) !== expected) disagreements.push(input);
      }
      // Sliced: five reproducible counter-examples are a diagnosis, twenty
      // thousand are a wall of text.
      expect(disagreements.slice(0, 5)).toEqual([]);
      // The generator has to actually produce URLs, or agreeing proves
      // nothing: a redactor that returned its input would pass an all-no-op
      // corpus.
      expect(redacted).toBeGreaterThan(5_000);
    });

    test('agrees on long adversarial shapes', () => {
      const shapes = [
        'a'.repeat(4_000),
        `https://${'a'.repeat(4_000)}`,
        `https://${'a'.repeat(2_000)}@host`,
        `https://user@${'a'.repeat(2_000)}`,
        `${'a'.repeat(2_000)}://user:pass@host`,
        `${'/'.repeat(2_000)}user@host`,
        `${'a@'.repeat(1_000)}`,
        `https://${'@'.repeat(1_000)}host`,
        `${'a://u@h '.repeat(500)}`,
        `${'a:'.repeat(1_000)}//user@host`,
      ];
      for (const shape of shapes) {
        expect(redactUrlCredentials(shape)).toBe(originalRedaction(shape));
      }
    });
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

describe('redactErrorCredentials (#1388)', () => {
  test('masks the userinfo in the message, the stack and a string property', () => {
    const original = new Error('connect ECONNREFUSED amqp://guest:hunter2@rabbit:5672/vhost');
    Object.assign(original, { code: 'ECONNREFUSED', endpoint: 'amqp://guest:hunter2@rabbit:5672' });

    const redacted = redactErrorCredentials(original);

    expect(redacted.message).toBe('connect ECONNREFUSED amqp://***@rabbit:5672/vhost');
    expect(redacted.stack).not.toContain('hunter2');
    expect((redacted as unknown as { endpoint: string }).endpoint).toBe('amqp://***@rabbit:5672');
    expect((redacted as unknown as { code: string }).code).toBe('ECONNREFUSED');
  });

  test('leaves the caller\'s error untouched', () => {
    // The `Error` belongs to the driver that threw it, which may still hold the
    // reference and may have handed it to listeners of its own — so the
    // redaction has to be a copy, not a scrub.
    const original = new Error('amqp://guest:hunter2@rabbit:5672');
    redactErrorCredentials(original);
    expect(original.message).toBe('amqp://guest:hunter2@rabbit:5672');
  });

  test('keeps the identity a monitor branches on', () => {
    // The reason this is a prototype-preserving copy rather than a plain wrap:
    // the type is what a subscriber switches on, and losing it would trade one
    // defect for another.
    class DriverError extends Error {
      constructor(message: string) { super(message); this.name = 'DriverError'; }
    }
    const redacted = redactErrorCredentials(new DriverError('redis://:s3cr3t@cache:6379 is down'));
    expect(redacted).toBeInstanceOf(DriverError);
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.name).toBe('DriverError');
    expect(redacted.message).toBe('redis://***@cache:6379 is down');
  });

  test('follows the cause chain, which the constructor makes non-enumerable', () => {
    const redacted = redactErrorCredentials(
      new Error('reconnect failed', { cause: new Error('mongodb://user:pass@cluster/db refused') }),
    );
    expect((redacted.cause as Error).message).toBe('mongodb://***@cluster/db refused');
  });

  test('terminates on a cyclic cause chain', () => {
    const a = new Error('amqp://u:p@a');
    const b = new Error('amqp://u:p@b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b, writable: true, configurable: true });
    const redacted = redactErrorCredentials(b);
    expect(redacted.message).toBe('amqp://***@b');
    expect((redacted.cause as Error).message).toBe('amqp://***@a');
  });

  test('reaches the errors inside an AggregateError', () => {
    // Not an exotic shape for this caller: Node raises an `AggregateError`
    // when a host name resolves to several addresses and every connection
    // fails, so a broker dialling a DNS name hits it on the ordinary path —
    // and each nested error names the same target the outer one would have.
    const aggregate = new AggregateError(
      [new Error('connect ECONNREFUSED amqp://u:hunter2@10.0.0.1:5672'),
       new Error('connect ECONNREFUSED amqp://u:hunter2@10.0.0.2:5672')],
      'all connection attempts failed',
    );
    const redacted = redactErrorCredentials(aggregate);
    const nested = (redacted as unknown as { errors: Error[] }).errors;
    expect(nested.map((e) => e.message)).toEqual([
      'connect ECONNREFUSED amqp://***@10.0.0.1:5672',
      'connect ECONNREFUSED amqp://***@10.0.0.2:5672',
    ]);
    expect(redacted).toBeInstanceOf(AggregateError);
  });

  test('is a no-op on a message with no credential in it', () => {
    // The overwhelmingly common case, and the one where a redactor that
    // mangles its input replaces a real diagnostic with a worse one.
    const original = new Error('socket hang up');
    const redacted = redactErrorCredentials(original);
    expect(redacted.message).toBe('socket hang up');
    expect(redacted.stack).toBe(original.stack);
  });
});
