/**
 * Smoke case: the public util helpers (#1034).
 *
 * `randomString` is the runtime-sensitive one — it reads entropy from
 * `globalThis.crypto.getRandomValues`, which is a Web API that Bun, Node
 * and Deno each provide from a different place.  A unit test on Bun
 * proves nothing about the other two, and the failure mode is not a type
 * error: it is generated actor names going undefined-shaped at runtime,
 * on whichever runtime the user picked.  `randomUuid` (#1109) is here for
 * exactly that reason and one more: it delegates to
 * `globalThis.crypto.randomUUID`, a *second* Web API off the same object,
 * and a runtime can carry one without the other.
 *
 * `safeStringify` and `lazyImportModule` ride along because they are the
 * other two names this issue put in the surface and they cost one call
 * each.  `lazyImportModule`'s rejection path is the interesting one —
 * the three runtimes word their own module-resolution failure
 * differently, and the helper's contract is that the message still names
 * the package and how to install it.
 *
 * The `exists` predicate (#1141) rides along for a weaker reason, stated
 * plainly: the retry loop is ordinary JavaScript and cannot differ per
 * runtime.  What it buys is that this file is the only place the four
 * helpers' *public call shapes* meet the built `dist/`, so the overloads
 * and the trailing parameter are exercised against what actually ships.
 * A thousand extra draws cost under a millisecond.
 */
export const name = 'public util helpers';
export const description = 'randomString entropy + safeStringify cycle + lazyImportModule error + URL redaction';

export async function run({ actorTs }) {
  const { randomString, randomHex, randomId, randomUuid, safeStringify, lazyImportModule } = actorTs;
  const { redactErrorCredentials, redactParsedUrlCredentials, redactUrlCredentials, redactedUrlLabel } = actorTs;

  for (const [label, value, pattern] of [
    ['randomHex', randomHex(16), /^[0-9a-f]{16}$/],
    ['randomId', randomId(12), /^[0-9a-f]{12}$/],
    ['randomString', randomString(24), /^[A-Za-z0-9]{24}$/],
    ['randomString(lowercase)', randomString(24, { upperCase: false, digits: false }), /^[a-z]{24}$/],
    ['randomUuid', randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
  ]) {
    if (!pattern.test(value)) throw new Error(`${label}: ${JSON.stringify(value)} !~ ${pattern}`);
  }
  if (randomHex(32) === randomHex(32)) throw new Error('randomHex returned the same value twice');
  if (randomUuid() === randomUuid()) throw new Error('randomUuid returned the same value twice');

  // Nine of the ten digits are taken, so '9' is the only value the predicate
  // lets through — the redraw is what has to find it.
  const taken = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
  const free = randomString(1, { lowerCase: false, upperCase: false }, (c) => taken.has(c));
  if (free !== '9') throw new Error(`randomString did not redraw to the one free digit: ${free}`);

  let attempts = 0;
  let exhausted = null;
  try {
    randomUuid(() => { attempts++; return true; });
  } catch (e) {
    exhausted = e.message;
  }
  if (exhausted === null) throw new Error('randomUuid with an always-taken predicate returned');
  if (attempts !== 1000) throw new Error(`randomUuid drew ${attempts} candidates, expected 1000`);
  if (!exhausted.includes('randomUuid')) {
    throw new Error(`exhaustion message does not name the helper: ${exhausted}`);
  }

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const rendered = safeStringify(cyclic);
  if (!rendered.includes('[Circular]')) {
    throw new Error(`safeStringify did not mark the cycle: ${rendered}`);
  }

  const missing = 'actor-ts-no-such-peer-dependency';
  let message = null;
  try {
    await lazyImportModule(missing, { context: 'SmokeCase' });
  } catch (e) {
    message = e.message;
  }
  if (message === null) throw new Error(`lazyImportModule('${missing}') resolved`);
  for (const expected of [`SmokeCase requires the '${missing}' package`, `npm install ${missing}`]) {
    if (!message.includes(expected)) {
      throw new Error(`lazyImportModule message missing ${JSON.stringify(expected)}: ${message}`);
    }
  }

  const nodePath = await lazyImportModule('node:path');
  if (typeof nodePath.join !== 'function') throw new Error('lazyImportModule lost the module shape');

  // URL redaction (#590, #592) is runtime-sensitive for one specific reason:
  // `redactedUrlLabel` parses with the WHATWG `URL`, and the NON-SPECIAL
  // schemes this project speaks (`mqtt:`, `amqp:`, `libsql:`) are exactly
  // where the three implementations differ on how much of the authority
  // survives.  `redactUrlCredentials` is pure string work and rides along
  // because its whole contract is being a no-op on the inputs the persistence
  // stores feed it (`:memory:`, `file:…`).
  for (const [input, expected] of [
    ['mongodb://user:pass@host:27017/db', 'mongodb://***@host:27017/db'],
    ['amqp://guest:guest@rabbit:5672/vhost', 'amqp://***@rabbit:5672/vhost'],
    [':memory:', ':memory:'],
    ['file:/tmp/actor-ts.db', 'file:/tmp/actor-ts.db'],
    ['not a url', 'not a url'],
    // A password with an unescaped `/`, `?` or `#` in it (found while #1458):
    // the userinfo runs to the last `@` before the next `://`.
    ['amqp://user:pa/PW1@host:5672/vhost', 'amqp://***@host:5672/vhost'],
    ['amqp://user:pa?PW1@host:5672/vhost', 'amqp://***@host:5672/vhost'],
    ['amqp://user:pa#PW1@host:5672/vhost', 'amqp://***@host:5672/vhost'],
    ['nats://u:pa/PW1@h1:4222,nats://u:pb?PW2@h2:4222', 'nats://***@h1:4222,nats://***@h2:4222'],
  ]) {
    const actual = redactUrlCredentials(input);
    if (actual !== expected) {
      throw new Error(`redactUrlCredentials(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  // The error copy applies the same scan to what a driver threw; the stack
  // repeats the message, so it has to come out clean too.
  for (const delimiter of ['/', '?', '#']) {
    const redacted = redactErrorCredentials(new Error(`connect ECONNREFUSED amqp://user:FRONT${delimiter}BACK@rabbit:5672/vhost`));
    const expected = 'connect ECONNREFUSED amqp://***@rabbit:5672/vhost';
    if (redacted.message !== expected || /FRONT|BACK/.test(String(redacted.stack))) {
      throw new Error(`redactErrorCredentials left the password with ${JSON.stringify(delimiter)} in it: ${JSON.stringify(redacted.message)}`);
    }
  }

  // A userinfo ends on its own line (#1458): every frame of a scoped package
  // carries an `@`, and a scan that ran on to the next `://` folded the
  // target and the first frame of a credential-free stack into one `***`.
  // The stack below is the shape Bun on Linux renders, set as a data
  // property, so every runtime scans it.
  const stack = [
    'Error: connect ECONNREFUSED nats://h1:4222',
    '    at dial (/app/node_modules/@nats-io/transport-node/lib/connect.js:8:27)',
    '    at connect (/app/node_modules/@nats-io/transport-node/lib/connect.js:4:10)',
  ].join('\n');
  const driverError = new Error('connect ECONNREFUSED nats://h1:4222');
  Object.defineProperty(driverError, 'stack', { value: stack, writable: true, configurable: true, enumerable: false });
  if (redactErrorCredentials(driverError).stack !== stack) {
    throw new Error('redactErrorCredentials changed a credential-free stack');
  }

  // The parsed-URL rendering (found while #1458) slices each runtime's own
  // `href` by the lengths of its `username`, `password` and `host`, so it is
  // only as portable as the three implementations' agreement on that
  // serialisation — a non-special scheme, an unescaped `@` in the password
  // and a reference resolved against a credentialed base included.
  for (const [url, expected] of [
    [new URL('https://registry.npmjs.org/@types%2fnode'), 'https://registry.npmjs.org/@types%2fnode'],
    [new URL('https://idp.example/authorize?login_hint=a@b'), 'https://idp.example/authorize?login_hint=a@b'],
    [new URL('redis://cache:6379/a@b'), 'redis://cache:6379/a@b'],
    [new URL('https://user:pass@registry.example/@scope/pkg'), 'https://***@registry.example/@scope/pkg'],
    [new URL('amqp://guest:guest@rabbit:5672/vhost'), 'amqp://***@rabbit:5672/vhost'],
    [new URL('https://u:p@ss@host/x'), 'https://***@host/x'],
    [new URL('/@user', 'https://u:p@h.example/a'), 'https://***@h.example/@user'],
    [new URL('https://proxy.example/fetch?target=http://user:pass@inner/x'), 'https://proxy.example/fetch?target=http://***@inner/x'],
  ]) {
    const actual = redactParsedUrlCredentials(url);
    if (actual !== expected) {
      throw new Error(`redactParsedUrlCredentials(${JSON.stringify(url.href)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  // The rest of the table are shapes that came back with a password in them
  // (found while #1458): a scheme-less `user:password@host`, which the WHATWG
  // parse reads as scheme `user:` plus an opaque path, and joined server
  // lists it took for one URL.  None of them may reach that parser any more,
  // and *which* inputs do is a decision every runtime has to make the same way
  // — the outputs below are pure string work once it is made.
  for (const [input, expected] of [
    ['wss://user:pass@example.com/ws/orders?token=abc', 'wss://example.com/ws/orders'],
    ['mqtt://user:pass@broker:1883', 'mqtt://broker:1883'],
    ['not a url', 'not a url'],
    ['a:SECRET1@h1:4222', '***@h1:4222'],
    ['memuser:SECRET1@cache:11211', '***@cache:11211'],
    ['a:SECRET1@h1:4222,b:SECRET2@h2:4222', '***@h1:4222,***@h2:4222'],
    ['nats://u:SECRET1@h1:4222,nats://u:SECRET2@h2:4222', 'nats://***@h1:4222,nats://***@h2:4222'],
    ['nats://u:SECRET1@h1,nats://u:SECRET2@h2', 'nats://***@h1,nats://***@h2'],
    ['nats://nats://u:SECRET1@h1:4222,nats://u:SECRET2@h2:4222', 'nats://nats://***@h1:4222,nats://***@h2:4222'],
    // A password with an unescaped `/`, `?` or `#` in it (also found while
    // #1458).  The label masks before it parses now.  Whether a host is named
    // turns on a WHATWG parse of what stands in front of the `/` — a numeric
    // front reads as a port, so `user:12` is a valid authority and the same
    // bytes are a URL for it — so this is where every runtime has to agree.
    // Behind a `?` or `#` the label ends at the mask.
    ['amqp://user:pa/PW1@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['amqp://user:pa#PW1@host:5672/vhost', 'amqp://***'],
    ['amqp://user:12/PW1@host:5672/vhost', 'amqp://***'],
    ['https://user:12?PW1@feed.example/events', 'https://***'],
    ['libsql://tok/en@db.turso.io', 'libsql://***'],
    ['user:pa?PW1@h1:4222,nats://u:pb#PW2@h2:4222', '***'],
    // An `@` past the host names no host (#1458): the same bytes are a
    // password ending in `ops` for `example.com`.  Turns on the same parse.
    ['https://user:pass@hooks.example/notify?to=ops@example.com', 'https://***'],
    ['wss://chat.example.com/rooms/@general', 'wss://***'],
    // A password with an `@` in front of a comma: v0.17.0 hid `b`.
    ['amqp://user:a@b,c@host', 'amqp://***@host'],
    // A password with a comma in it (found while #1458) is masked across the
    // whole value before the list is split, to its last `@`: a scheme-less
    // entry behind a credentialed one is part of that userinfo, and the
    // `***@` stays to say hosts went with it.
    ['amqp://user:a,b@host:5672/vhost', 'amqp://host:5672/vhost'],
    ['nats://u:p,1@h1:4222,v:p2@h2:4222', 'nats://***@h2:4222'],
    ['nats://h1:4222,u:SECRET2@h2:4222', 'nats://***@h2:4222'],
    // Not a leak but the same misreading: `localhost:` taken for a scheme
    // turned this into `localhost://4222`.
    ['localhost:4222', 'localhost:4222'],
  ]) {
    const actual = redactedUrlLabel(input);
    if (actual !== expected) {
      throw new Error(`redactedUrlLabel(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
}
