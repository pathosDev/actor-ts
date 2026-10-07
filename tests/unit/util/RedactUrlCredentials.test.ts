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
import fc from 'fast-check';
import {
  redactErrorCredentials,
  redactParsedUrlCredentials,
  redactUrlCredentials,
  redactedUrlLabel,
} from '../../../src/util/RedactUrlCredentials.js';

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
    // -- a password with an unescaped `/`, `?` or `#` in it (found while
    //    #1458).  RFC 3986 wants all three percent-encoded inside userinfo,
    //    but a password is pasted as it is, and ending the authority at the
    //    first one printed the password whole.  The userinfo now runs to the
    //    last `@` before the next `://`, and only what follows that `@` is
    //    host, path and query — kept byte-identical.
    ['amqp://user:pa/PW1@host:5672/vhost', 'amqp://***@host:5672/vhost'],
    ['amqp://user:pa?PW1@host:5672/vhost', 'amqp://***@host:5672/vhost'],
    ['amqp://user:pa#PW1@host:5672/vhost', 'amqp://***@host:5672/vhost'],
    // A numeric front is what a WHATWG parse takes for a port.
    ['amqp://user:12/PW1@host:5672/vhost', 'amqp://***@host:5672/vhost'],
    ['libsql://tok/en@db.turso.io', 'libsql://***@db.turso.io'],
    ['redis://:a/b?c#d@cache:6379/0?db=1#top', 'redis://***@cache:6379/0?db=1#top'],
    ['nats://u:pa/PW1@h1:4222,nats://u:pb?PW2@h2:4222', 'nats://***@h1:4222,nats://***@h2:4222'],
    // The price of that reading: an `@` further on in a path, query or
    // fragment looks exactly like the end of such a password, so it is taken
    // for one, and what precedes it is masked with the userinfo.  These three
    // were pinned as no-ops before #1458.  Masking a host that carried no
    // secret costs a log line some of its diagnostic value; the opposite
    // reading prints a password.
    ['redis://cache:6379/a@b', 'redis://***@b'],
    ['https://host?u@p', 'https://***@p'],
    ['https://host#u@p', 'https://***@p'],
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
    // No `//` authority at all.
    'mailto:ops@example.com',
    'postgres',
    // -- boundaries of the scan, pinned alongside the linear rewrite (#1198).
    // No scheme in front of the `://`, so there is no URL here to redact.
    '://user@host',
    '//user@host',
    '1://user@host',
    '+://user@host',
    // A second `://` ends the scan for an `@` even where no scheme stands in
    // front of it, so the `@` past it is nobody's userinfo.
    'https://h1/a ://u@h2',
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
   * The differential half of the #1198 rewrite, moved once, on purpose, by
   * #1458.
   *
   * `redactUrlCredentials` is exported from `src/index.ts`, so its output is
   * public API.  The tables above pin the cases a human thought of; this pins
   * the ones nobody did, by running the grammar **written as a regex** — kept
   * here as an oracle — over inputs built from the alphabet that decides the
   * match, and demanding byte equality.  The scan is that regex with its
   * backtracking written out, and the regex is what a reader checks it
   * against.
   *
   * #1198 committed this before its rewrite, with the original pattern as the
   * oracle, so the rewrite could not move the behaviour unnoticed.  #1458
   * moves it deliberately — the original ended the userinfo at the first `/`,
   * `?` or `#`, and a password containing one printed whole — so the original
   * pattern stays as well, as the statement of what that move may do: mask
   * further, and nothing else.  Wherever the original masked, the grammar
   * masks at least as far, which is `grammar(original(x)) === grammar(x)`.
   * The generator is seeded, so a failure names a reproducible input rather
   * than a number that never comes back.
   */
  describe('behaviour is byte-identical to the grammar written as a regex (#1198, #1458)', () => {
    /** A scheme, `://`, then everything up to the last `@` before the next `://`. */
    const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:(?!:\/\/)[\s\S])*@/g;

    /** #1198's oracle: the authority ended at the first `/`, `?` or `#`. */
    const BEFORE_1458_URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/g;

    function grammarRedaction(value: string): string {
      return value.replace(URL_USERINFO, '$1***@');
    }

    function before1458Redaction(value: string): string {
      return value.replace(BEFORE_1458_URL_USERINFO, '$1***@');
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

    /**
     * Userinfo-legal characters — everything but a `://`.  `/`, `?` and `#`
     * are in since #1458: they are what a pasted password carries, and what
     * the original pattern stopped at.
     */
    const USERINFO_TOKENS = ['a', 'A', 'ab', '1', '+', '.', '-', ':', '@', 'x', ' ', '/', '?', '#'];

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

    test('agrees with the grammar on 20 000 generated inputs, and masks at least as far as the original', () => {
      const next = randomSequence(0x1198_2026);
      const disagreements: string[] = [];
      const maskedLessThanTheOriginal: string[] = [];
      let redacted = 0;
      let movedBy1458 = 0;
      for (let i = 0; i < 20_000; i++) {
        const input = generateInput(next);
        const expected = grammarRedaction(input);
        const actual = redactUrlCredentials(input);
        if (expected !== input) redacted++;
        if (expected !== before1458Redaction(input)) movedBy1458++;
        if (actual !== expected) disagreements.push(input);
        if (redactUrlCredentials(before1458Redaction(input)) !== actual) maskedLessThanTheOriginal.push(input);
      }
      // Sliced: five reproducible counter-examples are a diagnosis, twenty
      // thousand are a wall of text.
      expect(disagreements.slice(0, 5)).toEqual([]);
      expect(maskedLessThanTheOriginal.slice(0, 5)).toEqual([]);
      // The generator has to actually produce URLs, or agreeing proves
      // nothing: a redactor that returned its input would pass an all-no-op
      // corpus.
      expect(redacted).toBeGreaterThan(5_000);
      // And it has to reach the inputs #1458 is about, or agreeing with the
      // grammar proves no more than agreeing with the original did.
      expect(movedBy1458).toBeGreaterThan(2_000);
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
        // -- the delimiters #1458 let into the userinfo
        `https://${'/'.repeat(4_000)}`,
        `https://u${'/?#'.repeat(1_000)}@host`,
        `${'https://h/a@b '.repeat(500)}`,
        `${'a://'.repeat(1_000)}u@h`,
      ];
      for (const shape of shapes) {
        expect(redactUrlCredentials(shape)).toBe(grammarRedaction(shape));
      }
    });
  });
});

/**
 * Found while #1458.  The scan cannot know where a string's authority ends,
 * so it reads everything up to the last `@` before the next `://` as userinfo
 * — and a URL with an `@` in its path or its query, which carries no
 * credential at all, loses its host to the mask.  A URL the runtime has
 * parsed carries the answer: its `username` and `password` are the credential
 * that travels and nothing else is, so those two are what this masks exactly.
 * What follows the host is text the URL carries, and a URL written into that
 * text was never parsed — so the scan still reads it, as it would anywhere.
 */
describe('redactParsedUrlCredentials (found while #1458)', () => {
  // Mutable tuples, for the same `test.each` typing reason as above.
  const overMaskedByTheScan: ReadonlyArray<[string, string]> = [
    // An npm scoped package, a profile path, an OAuth login hint: real shapes
    // the scan renders as if the host were whatever follows the `@`.
    ['https://registry.npmjs.org/@types%2fnode', 'https://***@types%2fnode'],
    ['https://example.com/@user', 'https://***@user'],
    ['https://idp.example/authorize?login_hint=a@b', 'https://***@b'],
    ['https://idp.example/callback#state=a@b', 'https://***@b'],
    ['redis://cache:6379/a@b', 'redis://***@b'],
  ];

  test.each([...overMaskedByTheScan])('renders %p as it is, where the scan gives %p', (input, scanned) => {
    expect(redactUrlCredentials(input)).toBe(scanned);
    expect(redactParsedUrlCredentials(new URL(input))).toBe(input);
  });

  const masked: ReadonlyArray<[string, string]> = [
    ['https://u:p@host/x', 'https://***@host/x'],
    // A username alone and a password alone are each a credential.
    ['https://user@host/x', 'https://***@host/x'],
    ['https://:secret@host/x', 'https://***@host/x'],
    ['amqp://guest:guest@rabbit:5672/vhost', 'amqp://***@rabbit:5672/vhost'],
    // A credential and an `@` further on: only the first is the userinfo.
    ['https://u:p@registry.example/@scope/pkg?login_hint=a@b', 'https://***@registry.example/@scope/pkg?login_hint=a@b'],
    // An unescaped `@` in the password: WHATWG splits at the last one and
    // `href` carries the first one encoded, inside the userinfo it replaces.
    ['https://u:p@ss@host/x', 'https://***@host/x'],
    // An empty query and an empty fragment are part of `href` too; a
    // rendering rebuilt from `search` and `hash` would drop both.
    ['https://u:p@host/x?#', 'https://***@host/x?#'],
    // A special scheme with no slashes still has an authority once parsed,
    // which a scan for `://` never finds.
    ['https:u:p@host/x', 'https://***@host/x'],
  ];

  test.each([...masked])('masks the credential of %p and nothing else', (input, expected) => {
    expect(redactParsedUrlCredentials(new URL(input))).toBe(expected);
  });

  // A URL inside the path, the query or the fragment is not the one that was
  // parsed: nothing split its userinfo from its host, so masking only the
  // outer credential would print the inner one whole — where every rendering
  // of these strings before this helper existed masked it.
  const nested: ReadonlyArray<[string, string]> = [
    ['https://proxy.example/fetch?target=http://user:pass@inner/x', 'https://proxy.example/fetch?target=http://***@inner/x'],
    ['https://idp.example/cb#next=https://u:p@app/x', 'https://idp.example/cb#next=https://***@app/x'],
    ['https://h.example/a/http://u:p@inner/b', 'https://h.example/a/http://***@inner/b'],
    [
      'https://u:p@proxy.example/fetch?target=http://user:pass@inner/x',
      'https://***@proxy.example/fetch?target=http://***@inner/x',
    ],
    // No authority at all: everything after the scheme is path.
    ['data:text/plain,amqp://guest:guest@rabbit/', 'data:text/plain,amqp://***@rabbit/'],
  ];

  test.each([...nested])('masks the URL nested in %p as the scan does', (input, expected) => {
    expect(redactParsedUrlCredentials(new URL(input))).toBe(expected);
    expect(redactUrlCredentials(input)).toBe(expected);
  });

  test('leaves a URL with no authority and nothing nested in it as it is', () => {
    expect(redactParsedUrlCredentials(new URL('mailto:ops@example.com'))).toBe('mailto:ops@example.com');
  });

  test('leaves no fragment of the credential behind', () => {
    const redacted = redactParsedUrlCredentials(new URL('mongodb://admin:hunter2@host:27017/db'));
    expect(redacted).toBe('mongodb://***@host:27017/db');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('admin');
  });

  test('is the serialisation the runtime uses, normalised the way `href` is', () => {
    // Not what an operator typed but what the runtime sends — which is why the
    // scan, which keeps the typed string, stays the rendering for a value that
    // has not been parsed for use.
    expect(redactParsedUrlCredentials(new URL('HTTPS://U:P@Host.Example:443/A?b#c')))
      .toBe('https://***@host.example/A?b#c');
  });

  /**
   * The tables pin the shapes somebody thought of; this pins the contract
   * over the ones nobody did, against a second implementation that shares no
   * slicing with the first: blank the credential through the `URL` setters,
   * put the mask back behind the `//`, and hand what follows the host to the
   * scan.  The userinfo, the path, the query and the fragment are drawn over
   * the characters that decide a split — `@`, `:`, `/`, `?`, `#`, `%` — the
   * last three may each carry a whole nested `scheme://userinfo@host`, and the
   * setters encode whatever `href` needs encoded.
   */
  test('agrees with blanking the credential through the URL setters and scanning the rest, for any userinfo and any @ or URL further on', () => {
    const text = fc.string({
      unit: fc.constantFrom('a', 'Z', '0', '@', ':', '/', '?', '#', '%', '.', ' '),
      maxLength: 6,
    });
    const nestedUrl = fc.tuple(fc.constantFrom('http', 'amqp'), text, text)
      .map(([scheme, userinfo, host]) => `${scheme}://${userinfo}@${host}`);
    const part = fc.oneof(text, nestedUrl);
    const origin = fc.constantFrom('https://h.example', 'http://10.0.0.4:8080', 'amqp://rabbit:5672', 'wss://[::1]');
    fc.assert(fc.property(origin, text, text, part, part, part, (base, username, password, path, query, fragment) => {
      const url = new URL(base);
      url.username = username;
      url.password = password;
      url.pathname = `/${path}`;
      url.search = query;
      url.hash = fragment;
      const bare = new URL(url.href);
      bare.username = '';
      bare.password = '';
      const authority = `${bare.protocol}//${bare.host}`;
      const credential = url.username === '' && url.password === '' ? '' : '***@';
      const rest = redactUrlCredentials(bare.href.slice(authority.length));
      expect(redactParsedUrlCredentials(url)).toBe(`${bare.protocol}//${credential}${bare.host}${rest}`);
    }));
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

  /**
   * Found while #1458.  A label is what this project hands to logs and to the
   * broker lifecycle events as already safe (#741), so it may not carry a
   * credential whatever shape the input has.  Every input below came back
   * with one in it before the fix — identically on Bun, Node and Deno, since
   * the leak lies in what the WHATWG parse *means*, not in how a runtime
   * implements it.  Two shapes did it:
   *
   *   - a scheme-less `user:password@host`, the server form memjs and nats.js
   *     both accept.  The parser reads `user:` as a scheme and
   *     `password@host` as an opaque path, and a label rebuilt from protocol,
   *     host and path printed it as `user://password@host`;
   *   - a joined server list, which the parser can take for one URL.  Without
   *     ports, `nats://u:p1@h1,nats://u:p2@h2` is the host `h1,nats` with the
   *     rest of the list for a path, so the second password came back.
   */
  const leakedBefore: ReadonlyArray<[string, string]> = [
    // -- scheme-less userinfo
    ['a:SECRET1@h1:4222', '***@h1:4222'],
    ['memuser:SECRET1@cache:11211', '***@cache:11211'],
    ['user:SECRET1@host', '***@host'],
    // A token alone, an empty user, a user no scheme can start with: the
    // parse throws on all three, and the scan behind it needed a `://`.
    ['TOKEN1@h1:4222', '***@h1:4222'],
    [':SECRET1@h1:4222', '***@h1:4222'],
    ['1user:SECRET1@h1:4222', '***@h1:4222'],
    ['u:SECRET1@[::1]:4222', '***@[::1]:4222'],
    ['u:SECRET1@h1:4222/x?token=QUERYSECRET#f', '***@h1:4222/x'],
    // A `://` further in does not make the entry a URL: what decides is
    // whether it *begins* with a scheme, and both credentials have to go.
    ['u:SECRET1@h1:4222/x/nats://v:SECRET2@h2:4222', '***@h1:4222/x/nats://***@h2:4222'],
    // -- joined lists: NatsActor joins `servers` as typed, adding no scheme
    ['a:SECRET1@h1:4222,b:SECRET2@h2:4222', '***@h1:4222,***@h2:4222'],
    ['memuser:SECRET1@c1:11211,memuser:SECRET2@c2:11211', '***@c1:11211,***@c2:11211'],
    ['nats://u:SECRET1@h1,nats://u:SECRET2@h2', 'nats://***@h1,nats://***@h2'],
    ['nats://u:SECRET1@n1.example,nats://u:SECRET2@n2.example', 'nats://***@n1.example,nats://***@n2.example'],
    ['u:SECRET1@h1:4222,nats://u:SECRET2@h2:4222', '***@h1:4222,nats://***@h2:4222'],
    // A path on the first entry ended its authority, so the parse succeeded
    // and read the scheme-less second entry as more path.  The first host
    // goes too since a password may hold a comma: `h1:4222/x,u:SECRET2` is
    // byte for byte such a password, with a `/` in it as well, and what is
    // left is one URL (see the describe on commas below).
    ['nats://h1:4222/x,u:SECRET2@h2:4222', 'nats://h2:4222'],
    // -- what the JetStream actors build: `nats://` in front of that list
    ['nats://nats://u:SECRET1@h1:4222', 'nats://nats://***@h1:4222'],
    ['nats://nats://u:SECRET1@h1:4222,nats://u:SECRET2@h2:4222', 'nats://nats://***@h1:4222,nats://***@h2:4222'],
    ['nats://nats://u:SECRET1@h1:4222,nats://u:SECRET2@h2:4222/kv/orders', 'nats://nats://***@h1:4222,nats://***@h2:4222/kv/orders'],
    // The property below, on the unfixed tree: its first counterexample
    // (seed 1424, unshrunk because the suite ends on the first failure).
    [
      'nats://redis://TOKEN0@10.0.0.4:39378/kv/orders,:SECRET1@10.0.0.4?token=QUERYSECRET',
      'nats://redis://***@10.0.0.4:39378/kv/orders,***@10.0.0.4',
    ],
    // -- a secret with an unescaped `/`, `?` or `#` in it (found while
    //    #1458).  The parse fails on all of these, and the scan behind it
    //    ended the userinfo at the delimiter: the first two printed the whole
    //    password, the rest everything up to the `?` or `#`.
    ['amqp://user:pa/PW1@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['https://user:pa/PW1@host/feed', 'https://host/feed'],
    ['amqp://user:pa?PW1@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['amqp://user:pa#PW1@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['redis://:pa#PW1@cache:6379/0', 'redis://cache:6379/0'],
    ['user:pa#PW1@h1:4222', '***@h1:4222'],
    ['a:pa#PW1@h1:4222,b:pb/PW2@h2:4222', '***@h1:4222,***@h2:4222'],
    // And these the parse accepted, which put the secret into the host, port
    // and path the label is built from: a numeric front reads as a port, a
    // token as a host.
    ['amqp://user:12/PW1@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['amqp://user:12#PW1@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['libsql://tok/en@db.turso.io', 'libsql://db.turso.io'],
    // The property below, extended over that alphabet, on the unfixed tree:
    // its first counterexample (seed 1424, unshrunk).  The label came back as
    // `nats://redis://TOKEN0` — the token, and not the second server.
    [
      'nats://redis://TOKEN0?TAIL0N0?TAIL0N1@10.0.0.4:39378/kv/orders,tls://TOKEN1@[::1]:29713',
      'nats://redis://***@10.0.0.4:39378/kv/orders,tls://***@[::1]:29713',
    ],
  ];

  test.each([...leakedBefore])('masks every credential in %p', (input, expected) => {
    expect(redactedUrlLabel(input)).toBe(expected);
  });

  test('a scheme-less user:password@host keeps no part of the password', () => {
    expect(redactedUrlLabel('a:SECRET1@h1:4222')).not.toContain('SECRET1');
  });

  test('a joined list of two credentialed URLs keeps neither password, with or without ports', () => {
    for (const list of [
      'nats://u:PASSWORD1@h1:4222,nats://u:PASSWORD2@h2:4222',
      'nats://u:PASSWORD1@h1,nats://u:PASSWORD2@h2',
    ]) {
      const label = redactedUrlLabel(list);
      expect(label).not.toContain('PASSWORD1');
      expect(label).not.toContain('PASSWORD2');
    }
  });

  test('a joined list keeps its shape — each entry masked, none flattened away', () => {
    // The shape the broker lifecycle events document (#741): an operator
    // still sees how many servers there are and which ones.
    expect(redactedUrlLabel('nats://u:p1@h1:4222,nats://u:p2@h2:4222'))
      .toBe('nats://***@h1:4222,nats://***@h2:4222');
  });

  test('the query is cut from the list as a whole, so a comma inside it starts no entry', () => {
    expect(redactedUrlLabel('nats://h1:4222,nats://h2:4222?token=QUERYSECRET,QUERYTAIL'))
      .toBe('nats://h1:4222,nats://h2:4222');
  });

  /**
   * The opposite defect: masking that eats a label with nothing to hide.  A
   * bare `host:port` is the commonest NATS server entry, and the parse read
   * it as the scheme `localhost:` — `localhost:4222` came back as
   * `localhost://4222`.  It is not a URL, so it is no longer parsed as one.
   */
  const keepsIdentity: readonly string[] = [
    'localhost:4222',
    'h1:4222,h2:4222',
    'nats://h1:4222,nats://h2:4222',
    'nats://h1:4222,h2:4222',
    'kafka://k1:9092,k2:9092',
    'imap://mail.example:993 + smtp://mail.example:587',
    'tcp://10.0.0.4:9000',
  ];

  test.each([...keepsIdentity])('leaves %p as it is', (input) => {
    expect(redactedUrlLabel(input)).toBe(input);
  });

  /**
   * The tables pin shapes somebody thought of; this pins the law over the
   * ones nobody did.  Each entry carries its own markers where a credential
   * goes, the entries are joined the ways the broker actors join them — with
   * or without the `nats://` the JetStream actors put in front — and no
   * marker may reach the label, while every host has to: "replace it all
   * with ***" satisfies the first half and fails the second.
   *
   * Since #1458 a secret is drawn over the delimiters too: an unescaped `/`,
   * `?` or `#` between fragments that are markers of their own, behind a
   * numeric front now and then — the shape a URL parse takes for a port.
   * Such a userinfo cannot be told apart from a path or a query by looking at
   * it, so it is masked to its last `@`, and this is where that has to hold
   * for every entry of every list.
   *
   * And over a comma, wherever a `://` opens the entry (found while #1458):
   * the scheme-form userinfo of the whole list is masked before the list is
   * split, so a comma in front of the first `@` can no longer cut a password
   * in two.  A scheme-less entry has nothing that says where its userinfo
   * begins, so a comma in its password reads as a list separator to any rule
   * and none is drawn there.  The same reading has a price in hosts: an entry
   * a `://` opens and no credential follows, trailed by scheme-less entries up
   * to one that carries a credential, is that credential's userinfo — byte
   * for byte a password with a comma in it — so those hosts are not asserted.
   */
  test('no credential reaches the label and every host does, for any joined server list', () => {
    const entryArbitrary = fc.record({
      scheme: fc.constantFrom('', 'nats://', 'tls://', 'redis://'),
      credential: fc.constantFrom('none', 'token', 'user-and-password', 'password-only'),
      host: fc.constantFrom('h1', 'n1.example', '10.0.0.4', '[::1]'),
      port: fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: null }),
      path: fc.constantFrom('', '/kv/orders'),
      secretDelimiters: fc.array(fc.constantFrom('/', '?', '#', ','), { maxLength: 2 }),
      numericFront: fc.boolean(),
    });
    const listArbitrary = fc.record({
      entries: fc.array(entryArbitrary, { minLength: 1, maxLength: 4 }),
      jetStreamPrefix: fc.boolean(),
      separator: fc.constantFrom(',', ', '),
      query: fc.boolean(),
    });
    fc.assert(fc.property(listArbitrary, (list) => {
      // Whether a `://` opens entry `index`: its own scheme, or the one the
      // JetStream actors put in front of the first entry.
      const opened = (index: number): boolean =>
        list.entries[index]!.scheme !== '' || (index === 0 && list.jetStreamPrefix);
      const markers = ['QUERYSECRET', 'QUERYTAIL'];
      const rendered = list.entries.map((entry, index) => {
        const delimiters = opened(index) ? entry.secretDelimiters : entry.secretDelimiters.filter((d) => d !== ',');
        // `TAIL0N1` is what follows the second delimiter of entry 0's secret.
        const tails = delimiters.map((delimiter, position) => `${delimiter}TAIL${index}N${position}`);
        markers.push(`TOKEN${index}`, `USER${index}`, `SECRET${index}`, ...tails.map((tail) => tail.slice(1)));
        const secret = (marker: string): string => `${entry.numericFront ? '12' : marker}${tails.join('')}`;
        const credential = entry.credential === 'token' ? `${secret(`TOKEN${index}`)}@`
          : entry.credential === 'user-and-password' ? `USER${index}:${secret(`SECRET${index}`)}@`
            : entry.credential === 'password-only' ? `:${secret(`SECRET${index}`)}@`
              : '';
        const port = entry.port === null ? '' : `:${entry.port}`;
        return `${entry.scheme}${credential}${entry.host}${port}${entry.path}`;
      });
      const prefix = list.jetStreamPrefix ? 'nats://' : '';
      // A comma inside the query too: the query is cut from the list as a
      // whole, or its tail comes back as one more "entry".
      const query = list.query ? '?token=QUERYSECRET,QUERYTAIL' : '';
      const label = redactedUrlLabel(`${prefix}${rendered.join(list.separator)}${query}`);
      for (const marker of markers) expect(label).not.toContain(marker);
      // The hosts the comma reading takes with it, worked out from the list
      // rather than from the label: an opened entry with no credential, and
      // every scheme-less one after it, up to the first with a credential.
      const taken = new Set<number>();
      list.entries.forEach((entry, index) => {
        if (!opened(index) || entry.credential !== 'none') return;
        for (let next = index + 1; next < list.entries.length; next++) {
          if (opened(next)) return;
          if (list.entries[next]!.credential === 'none') continue;
          for (let held = index; held < next; held++) taken.add(held);
          return;
        }
      });
      list.entries.forEach((entry, index) => {
        if (!taken.has(index)) expect(label).toContain(entry.host);
      });
    }));
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

/**
 * Found while #1458.  RFC 3986 wants a `/`, `?` or `#` inside userinfo
 * percent-encoded, but a password is pasted as it is — and the driver then
 * fails to connect, which is the worst case: the reconnect loop republishes
 * the endpoint on every backoff tick.  All three renderings ended the
 * authority at the first of the three, so the scan and the error copy printed
 * such a password whole, and the label printed it whole or up to the
 * delimiter.  Each side of the delimiter is a marker of its own here, so a
 * rendering that keeps either half is caught, and the host has to come
 * through every one of them.
 */
describe('a password with an unescaped "/", "?" or "#" in it (found while #1458)', () => {
  // Mutable tuples, for the same `test.each` typing reason as above.
  const delimiters: Array<[string]> = [['/'], ['?'], ['#']];
  const markers = ['USER', 'FRONT', 'BACK'];
  const urlWith = (delimiter: string): string => `amqp://USER:FRONT${delimiter}BACK@rabbit.example:5672/vhost`;

  test.each(delimiters)('redactUrlCredentials keeps no fragment of a password containing %p', (delimiter) => {
    const redacted = redactUrlCredentials(urlWith(delimiter));
    for (const marker of markers) expect(redacted).not.toContain(marker);
    expect(redacted).toBe('amqp://***@rabbit.example:5672/vhost');
  });

  test.each(delimiters)('redactedUrlLabel keeps no fragment of a password containing %p', (delimiter) => {
    const label = redactedUrlLabel(urlWith(delimiter));
    for (const marker of markers) expect(label).not.toContain(marker);
    expect(label).toBe('amqp://rabbit.example:5672/vhost');
  });

  test.each(delimiters)('redactErrorCredentials keeps no fragment of a password containing %p', (delimiter) => {
    const original = new Error(`connect ECONNREFUSED ${urlWith(delimiter)}`);
    Object.assign(original, { endpoint: urlWith(delimiter) });
    const redacted = redactErrorCredentials(original);
    const endpoint = (redacted as unknown as { endpoint: string }).endpoint;
    for (const marker of markers) {
      expect(redacted.message).not.toContain(marker);
      expect(redacted.stack).not.toContain(marker);
      expect(endpoint).not.toContain(marker);
    }
    expect(redacted.message).toBe('connect ECONNREFUSED amqp://***@rabbit.example:5672/vhost');
    expect(endpoint).toBe('amqp://***@rabbit.example:5672/vhost');
  });

  // A numeric front is the shape the WHATWG parse behind the label accepts
  // rather than rejects: `USER:12` reads as a host and a port, and the rest
  // of the password as a path, a query or a fragment.  The parse succeeding
  // is what used to put the password into the label.
  test.each(delimiters)('a password with a numeric front and %p in it reaches no label', (delimiter) => {
    expect(redactedUrlLabel(`amqp://USER:12${delimiter}BACK@rabbit.example:5672/vhost`))
      .toBe('amqp://rabbit.example:5672/vhost');
    expect(redactedUrlLabel(`https://USER:12${delimiter}BACK@feed.example/events`))
      .toBe('https://feed.example/events');
  });

  test.each(delimiters)('every entry of a joined list is masked by the same rule, with %p in each password', (delimiter) => {
    const password = `FRONT${delimiter}BACK`;
    // The label splits a list at its commas and masks entry by entry, a
    // scheme-less entry included.
    expect(redactedUrlLabel(`nats://u:${password}@h1:4222,v:${password}@h2:4222,nats://w:${password}@h3:4222`))
      .toBe('nats://***@h1:4222,***@h2:4222,nats://***@h3:4222');
    // The scan has no list in mind, and needs none: the next `://` ends one
    // entry's userinfo.
    expect(redactUrlCredentials(`nats://u:${password}@h1:4222,nats://v:${password}@h2:4222`))
      .toBe('nats://***@h1:4222,nats://***@h2:4222');
  });

  test.each(delimiters)('a scheme-less user:password@host with %p in the password reaches no label', (delimiter) => {
    expect(redactedUrlLabel(`USER:FRONT${delimiter}BACK@cache.example:11211`)).toBe('***@cache.example:11211');
  });
});

/**
 * Found while #1458.  The label split a value at its commas before it masked
 * anything, so a password with a comma in it was cut in two, and the part in
 * front of the comma — an entry with no `@` in it — came back as it was:
 * `amqp://user:a,b@host` was labelled `amqp://user:a,***@host`.  The
 * scheme-form userinfo of the whole value is masked first now, by the scan
 * with one more stop: a comma once an `@` has been seen, which is where the
 * next entry of a credentialed list begins.
 */
describe('a password with a comma in it (found while #1458)', () => {
  // Mutable tuples, for the same `test.each` typing reason as above.
  const labelled: ReadonlyArray<[string, string]> = [
    ['amqp://user:a,b@host', 'amqp://host'],
    ['amqp://user:a,b@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['amqp://user:a,b,c@host', 'amqp://host'],
    ['amqp://user:,@host', 'amqp://host'],
    ['amqp://user:a,b@host:5672/vhost?heartbeat=10', 'amqp://host:5672/vhost'],
    ['nats://nats://u:p,1@h1:4222', 'nats://nats://***@h1:4222'],
    // In a list, a comma after the `@` still starts the next entry, so every
    // host stays — a scheme-less entry behind it included.
    ['nats://u:p,1@h1:4222,nats://v:p,2@h2:4222', 'nats://***@h1:4222,nats://***@h2:4222'],
    ['nats://u:p,1@h1:4222,v:p2@h2:4222', 'nats://***@h1:4222,***@h2:4222'],
    ['amqp://h1,amqp://user:a,b@h2', 'amqp://h1,amqp://***@h2'],
    // The joined-list property, extended over a comma, on the unfixed tree:
    // its first counterexample (the pinned seed, unshrunk).  The label came
    // back with `TOKEN0/TAIL0N0` in it.
    [
      'nats://redis://TOKEN0/TAIL0N0,TAIL0N1@10.0.0.4:39378/kv/orders,tls://TOKEN1@[::1]:29713',
      'nats://redis://***@10.0.0.4:39378/kv/orders,tls://***@[::1]:29713',
    ],
  ];

  test.each([...labelled])('redactedUrlLabel masks the whole password in %p', (input, expected) => {
    expect(redactedUrlLabel(input)).toBe(expected);
  });

  test('keeps no fragment of the password, behind a numeric front or not', () => {
    for (const front of ['FRONT', '12']) {
      const label = redactedUrlLabel(`amqp://USER:${front},BACK@rabbit.example:5672/vhost`);
      for (const marker of ['USER', front, 'BACK']) expect(label).not.toContain(marker);
      expect(label).toBe('amqp://rabbit.example:5672/vhost');
    }
  });

  test('a credentialed list keeps every host, as it did before', () => {
    expect(redactedUrlLabel('nats://u:P1@h1:4222,v:P2@h2:4222,nats://w:P3@h3:4222'))
      .toBe('nats://***@h1:4222,***@h2:4222,nats://***@h3:4222');
  });

  // The price, pinned so that it stays a decision: an entry with no
  // credential in front of a scheme-less one that has one is the same string
  // as a password with a comma in it, and is labelled as that one URL.
  test('a credential-free entry in front of a scheme-less credentialed one goes with its userinfo', () => {
    expect(redactedUrlLabel('nats://h1:4222,u:SECRET2@h2:4222')).toBe('nats://h2:4222');
  });
});
