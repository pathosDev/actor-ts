/**
 * Credential-safe renderings of a connection URL, for **log lines and error
 * messages**.
 *
 * A connection URL is the one string in a configuration that routinely
 * carries a secret inline — `amqp://user:pass@host/vhost`,
 * `mongodb+srv://user:pass@cluster`, `redis://:token@host` — and the places
 * that report one are exactly the places least likely to be reviewed for
 * disclosure: a validator's rejection message, which `ActorCell` logs at
 * ERROR when `preStart` fails, and a per-frame warning a remote peer can
 * drive at will (#590, #592, #741).  Once that reaches a shipped log
 * aggregator the credential has to be rotated, not deleted.
 *
 * Two renderings, because the two callers want different things:
 *
 *   - {@link redactUrlCredentials} keeps the operator's own string intact
 *     apart from the userinfo, so a rejected value is still recognisable as
 *     what was typed.  Diagnostics first.
 *   - {@link redactedUrlLabel} reduces a URL to a stable *identity* —
 *     scheme, host, port, path — dropping the query as well, because that is
 *     where a bearer token ends up when the userinfo does not carry one.
 *     Disclosure first.
 *
 * And one for the case where the string is not ours to begin with:
 * {@link redactErrorCredentials} applies the first rendering to an `Error`
 * some driver threw, whose message routinely embeds the connection target the
 * caller was dialling (#1388).
 *
 * The first rendering has to guess where a userinfo ends, and guesses on the
 * side that cannot leak.  A URL the runtime has already parsed for a request
 * needs no guess, so {@link redactParsedUrlCredentials} masks exactly its
 * `username` and `password` instead (found while #1458).
 *
 * **Why a hand-written scan rather than a `URL` round-trip** for the first
 * one: blanking `username`/`password` on a parsed `URL` and reading `href`
 * back also lowercases the host, appends a trailing slash and re-encodes the
 * path, so an operator can fail to recognise the value they just mistyped —
 * and the non-special schemes this project speaks (`mqtt:`, `amqp:`,
 * `redis:`, `libsql:`) parse differently across the WHATWG implementations
 * in Bun, Node and Deno.  A scan also stays a strict no-op on the inputs
 * that are not URLs at all (`':memory:'`, `'file:local.db'`, `'not a url'`),
 * which is what keeps it safe to apply unconditionally on an error path.
 *
 * **And why not a regex.**  This was one until #1198:
 * `/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/g` — unanchored and global, so
 * the engine retried the scheme quantifier from every start position, and a
 * run of scheme characters with no `://` behind it cost O(n²).  That input
 * is not hypothetical: `HttpClient` runs this over the `Location` header of
 * a redirect, chosen by whichever server the caller was pointed at, which
 * bought 484 ms of blocked event loop per response at the 16 KiB header
 * limit — multiplied, on a single-threaded runtime, by every request in
 * flight.  Finding `://` first and validating the scheme *backwards* visits
 * each character a bounded number of times: the scheme run before a `://`
 * contains no `:` or `/`, and the scan for a userinfo stops at the next `://`,
 * so the forward scans of two candidates never overlap.
 *
 * {@link isSchemeStart} and {@link isSchemeCharacter} are that character
 * class, unchanged.  The userinfo is not: #1458 let it run past a `/`, `?` or
 * `#` to the last `@` before the next `://` — `(?:(?!://)[\s\S])*@` with its
 * backtracking written out, in {@link lastAtBeforeNextUrl} — because ending
 * it at the first of the three printed every password that contained one.
 * `tests/unit/util/RedactUrlCredentials.test.ts` keeps that pattern as an
 * oracle and compares the two over generated input, because what this
 * function redacts is public API (`src/index.ts`) — and keeps the original
 * one too, to show the move only ever masks further.
 *
 * This is deliberately **not** wired into a logger.  `MultiSinkLogger`'s
 * `transform` hook is the right seam for a record whose MDC already holds a
 * URL, and these functions are what you would call from such a transform —
 * but neither an `OptionsError` message (built long before any logger sees
 * it, and also thrown at the caller) nor the default `ConsoleLogger` passes
 * through that hook, so the redaction has to happen where the string is
 * built.
 */

/**
 * What replaces the userinfo.  Fixed rather than length-preserving on
 * purpose: a mask that mirrors the secret's length leaks its length.
 */
const USERINFO_MASK = '***';

/** What separates a scheme from its authority, and the anchor of the scan. */
const SCHEME_SEPARATOR = '://';

/**
 * What joins the entries of a server list into one label — `NatsActor`,
 * `KafkaActor` and the JetStream actors all build one.
 */
const LIST_SEPARATOR = ',';

/** The characters the scan turns on, as code points. */
const AT_SIGN = 0x40;
const COLON = 0x3a;

/** First query or fragment delimiter — everything from here is dropped. */
const QUERY_OR_FRAGMENT = /[?#]/;

/**
 * Replace the userinfo of every absolute URL in `value` with `***`, leaving
 * the rest of the string byte-identical.
 *
 * A no-op on anything without a `scheme://…@` in it, so it is safe to apply to
 * a value that only might be a URL.  The userinfo runs to the last `@` before
 * the next `://`, so a password with an unescaped `/`, `?` or `#` in it is
 * masked whole — see {@link lastAtBeforeNextUrl} for that reading and its
 * price.  Every URL in the string is covered, not just the first: a joined
 * server list (`nats://a:b@h1,nats://c:d@h2` — see `NatsActor`) has each
 * entry masked, and the entries cannot bleed into one another because a
 * userinfo stops at the `://` that opens the next one.
 */
export function redactUrlCredentials(value: string): string {
  // Written out rather than accumulated with `+=`: the pieces are slices of
  // one string, and joining them once keeps the copying proportional to the
  // output instead of to the number of matches.
  const pieces: string[] = [];
  let copiedTo = 0;
  let searchFrom = 0;
  for (;;) {
    const separator = value.indexOf(SCHEME_SEPARATOR, searchFrom);
    if (separator === -1) break;
    // Past this `://` unconditionally.  A candidate that fails here can
    // never succeed from a later start position — the scheme run and the
    // authority around it are fixed by the `://`, not by where the scan
    // began — so retrying inside it is exactly the work that made the old
    // pattern quadratic.
    const authorityStart = separator + SCHEME_SEPARATOR.length;
    searchFrom = authorityStart;
    if (!precededByScheme(value, separator)) continue;
    const userinfoEnd = lastAtBeforeNextUrl(value, authorityStart);
    if (userinfoEnd === -1) continue;
    pieces.push(value.slice(copiedTo, authorityStart), USERINFO_MASK);
    // Resume *at* the `@`: it is part of the output, and the next authority
    // cannot start before it.
    copiedTo = userinfoEnd;
    searchFrom = userinfoEnd + 1;
  }
  if (pieces.length === 0) return value;
  pieces.push(value.slice(copiedTo));
  return pieces.join('');
}

/** `ALPHA` — the only characters a scheme may begin with (RFC 3986 §3.1). */
function isSchemeStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a); // A-Z a-z
}

/** `ALPHA / DIGIT / "+" / "-" / "."` — the rest of a scheme (RFC 3986 §3.1). */
function isSchemeCharacter(code: number): boolean {
  return isSchemeStart(code)
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x2b || code === 0x2d || code === 0x2e; // + - .
}

/**
 * True when the run of scheme characters ending at `separator` contains at
 * least one letter — which is exactly the condition for a scheme to exist
 * there, since a match may begin at any letter in the run and every
 * character after it is scheme-legal by construction.
 *
 * *Where* in the run the scheme begins is deliberately not computed: the
 * scheme is copied through verbatim either way, so it cannot change the
 * output.  Walking backwards and stopping at the first letter is what makes
 * this bounded by the run rather than by the string.  No length cap — RFC
 * 3986 does not impose one, and a 300-character scheme still redacts.
 */
function precededByScheme(value: string, separator: number): boolean {
  for (let index = separator - 1; index >= 0; index--) {
    const code = value.charCodeAt(index);
    if (isSchemeStart(code)) return true;
    if (!isSchemeCharacter(code)) return false;
  }
  return false;
}

/**
 * Index of the last `@` between `from` and the next `://` (or the end of
 * `value`), or `-1`: where a userinfo that begins at `from` ends.
 *
 * Not at the first `/`, `?` or `#`, where RFC 3986 ends an authority and
 * where this scan stopped until #1458.  None of the three is legal inside a
 * userinfo, and all three turn up in a pasted password all the same — and the
 * driver then fails to connect, so the reconnect loop prints the result on
 * every backoff tick.  Stopping at the first of them printed that password
 * whole.  What lies between `://` and an `@` cannot be told apart from a host
 * and a path by looking at it (`user:12/PW1@host` is a host, a port and a path
 * too), so the reading that cannot leak wins: everything before the last `@`
 * is userinfo, and only what follows it is host, port, path and query.  The
 * *last* `@` also matches how WHATWG splits an authority whose password
 * contains an unescaped `@`.
 *
 * The price is paid by a URL with no credential and an `@` further on, in a
 * path, a query or a fragment: `redis://cache:6379/a@b` comes back as
 * `redis://***@b`.  That costs the line some of its diagnostic value; the
 * opposite error prints a password.
 *
 * The next `://` is the one bound kept.  It is where the next URL of a joined
 * list or a log line begins (`nats://a:b@h1,nats://c:d@h2`), and running past
 * it would mask the first entry's host together with the second entry's
 * userinfo.  It is also what keeps the scan linear.
 */
function lastAtBeforeNextUrl(value: string, from: number): number {
  let found = -1;
  for (let index = from; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === AT_SIGN) found = index;
    else if (code === COLON && value.startsWith(SCHEME_SEPARATOR, index)) break;
  }
  return found;
}

/**
 * `url` as its own `href`, with the username and the password replaced by
 * `***` and every other byte kept.
 *
 * For the URL a runtime actually uses — the one a request went to, or a
 * redirect target resolved against the request that received it — WHATWG's
 * `username` and `password` are exactly the credential that travels, so
 * masking those two cannot leak and cannot over-mask (found while #1458).
 * {@link redactUrlCredentials} has no parse to go by, reads up to the last `@`
 * before the next `://` as userinfo, and so hands back
 * `https://registry.npmjs.org/@types%2fnode` as `https://***@types%2fnode`;
 * here it comes back as it is.
 *
 * Only for a URL a request is made with, or would be.  Parsing a configured
 * string just to render it turns the trade around: a mistyped password with an
 * unescaped `/` in it parses as a host, a port and a path (`user:12/PW1@host`),
 * so the parse prints the very password it was meant to hide.  A value that
 * has not been parsed for a request, or does not parse at all, goes through
 * {@link redactUrlCredentials}.  And the result is normalised as `href` is —
 * lowercased host, encoded path — because it names what the runtime sends,
 * not what an operator typed.
 */
export function redactParsedUrlCredentials(url: URL): string {
  if (url.username === '' && url.password === '') return url.href;
  // `href` spells the userinfo exactly as the two getters do, straight after
  // `scheme://`, so its end is known by length.  Searching for the `@`
  // instead would meet one a path or a query is free to carry.
  const userinfo = url.password === '' ? url.username : `${url.username}:${url.password}`;
  const authorityStart = `${url.protocol}//`.length;
  return `${url.href.slice(0, authorityStart)}${USERINFO_MASK}${url.href.slice(authorityStart + userinfo.length)}`;
}

/**
 * The loggable identity of `value`: scheme, host, port and path, with the
 * userinfo **and** the query string removed.
 *
 * Keeping the path matters — it is what tells two connections to the same
 * host apart (`/ws/orders` vs `/ws/audit`), so reducing to the origin alone
 * would trade away the whole diagnostic value of the line.  The query is
 * dropped rather than kept for the same reason the userinfo is: a WebSocket
 * endpoint is commonly authenticated with a `?token=…`.
 *
 * Unlike {@link redactUrlCredentials} this normalises (the parse is a real
 * `URL` parse), which is fine for a label but not for echoing back what an
 * operator typed.
 *
 * **Every credential is masked by scan before anything is parsed or cut.**
 * The value is split at its commas, each entry is masked on its own — see
 * {@link maskedListEntry} — and only the rejoined, masked value reaches the
 * parse or the cut below.  That order is the fix for a password with an
 * unescaped `/`, `?` or `#` in it (found while #1458): the cut stopped at the
 * password's own `?` or `#` and left everything before it in the label, and
 * the parse ended the authority at its `/` — failing on `user:pa/PW1@host`,
 * which left the scan to print the password whole, and *succeeding* on
 * `user:12/PW1@host` or `tok/en@host`, which it reads as a host, a port and a
 * path.  A masked value has no `@` left in front of its host for a parse or a
 * cut to misread.
 *
 * **Only a value that is unambiguously one URL is parsed.**  Two shapes reach
 * this function as a matter of course through `BrokerActor`'s lifecycle
 * events and are not one (found while #1458):
 *
 *   - a scheme-less `user:password@host`, the server form memjs takes and
 *     nats.js accepts.  WHATWG reads `user:` as a scheme and `password@host`
 *     as an opaque path, so the label printed `user://password@host`;
 *   - a joined server list, which the parser can take for one URL with the
 *     rest of the list for a path: `nats://u:p1@h1,nats://u:p2@h2` is the
 *     host `h1,nats` and the path `//u:p2@h2`.  The `nats://` the JetStream
 *     actors put in front of a list of `nats://` URLs does the same with no
 *     comma at all.
 *
 * Anything else is cut at its query instead — the list as a whole, since a
 * query is free to contain commas, and a cut per entry would hand back what
 * follows one as one more server.  A masked entry keeps `***` where its
 * credential was (`***@h1:4222`), which also tells a reader one was there,
 * and the list keeps its shape, so an operator still sees which servers it
 * names.  A value with no credential anywhere (`<unknown>`, `localhost:4222`)
 * comes back as it is, minus any query, so the function stays total — and a
 * bare `host:port` stops reaching the parser that used to read `localhost:`
 * as a scheme.
 */
export function redactedUrlLabel(value: string): string {
  // Split and rejoined at the same commas, so `masked` has the shape of
  // `value` with nothing but its userinfo replaced.
  const masked = value.split(LIST_SEPARATOR).map(maskedListEntry).join(LIST_SEPARATOR);
  const parsed = parsedSingleUrl(masked);
  // Built field by field rather than from `origin`: for the non-special
  // schemes this project speaks (`mqtt:`, `amqp:`, `ws:` is special but
  // `libsql:` is not) WHATWG defines `origin` as the string `'null'`.
  if (parsed !== null) return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  return stripQueryAndFragment(masked);
}

/**
 * `value` parsed as a URL when it is unambiguously one, otherwise `null`.
 *
 * "Unambiguously" is three conditions, each the absence of one way the parse
 * could misread the value: `value` begins with `scheme://`, so there is an
 * authority to route userinfo out of (an opaque path has none); and before
 * its query there is neither a `,` nor a second `://`, either of which means
 * a list entry or another URL follows the first authority.  The value arrives
 * masked, so a misreading now costs the label its shape — a list taken for one
 * URL with the rest for a path; before #1458 moved the masking ahead of the
 * parse, it cost a credential in that path.  A `,` inside a single URL's path
 * costs that URL only its normalisation — it is cut at its query instead —
 * which is the cheap side of the trade.
 */
function parsedSingleUrl(value: string): URL | null {
  const authorityStart = authorityStartOf(value);
  if (authorityStart === -1) return null;
  const beforeQuery = stripQueryAndFragment(value);
  if (beforeQuery.includes(LIST_SEPARATOR)) return null;
  if (beforeQuery.includes(SCHEME_SEPARATOR, authorityStart)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Index just past the `scheme://` that `value` begins with, or `-1` when it
 * does not begin with one — the grammar of {@link isSchemeStart} and
 * {@link isSchemeCharacter}, anchored at the first character.
 */
function authorityStartOf(value: string): number {
  if (value.length === 0 || !isSchemeStart(value.charCodeAt(0))) return -1;
  let index = 1;
  while (index < value.length && isSchemeCharacter(value.charCodeAt(index))) index++;
  return value.startsWith(SCHEME_SEPARATOR, index) ? index + SCHEME_SEPARATOR.length : -1;
}

/**
 * One list entry with every credential in it masked.
 *
 * {@link redactUrlCredentials} covers each `scheme://…@` wherever it sits in
 * the entry.  An entry that does not *begin* with a scheme may itself be a
 * bare `userinfo@host[:port]`, and there no `://` marks where the userinfo
 * starts — so the last `@` before the entry's first `://` is taken to end one
 * that starts the entry, by the same rule as a userinfo behind a scheme: a
 * `/`, `?` or `#` in front of that `@` is part of the password, not the end of
 * it (#1458).  That reading is wrong for an e-mail address
 * (`mailto:ops@example.com` keeps only `***@example.com`), which costs a label
 * nothing it needs; the opposite error prints a password.
 */
function maskedListEntry(entry: string): string {
  const masked = redactUrlCredentials(entry);
  if (authorityStartOf(masked) !== -1) return masked;
  const userinfoEnd = lastAtBeforeNextUrl(masked, 0);
  return userinfoEnd === -1 ? masked : `${USERINFO_MASK}${masked.slice(userinfoEnd)}`;
}

/** Cut at the first `?` or `#`; returns `value` unchanged when it has neither. */
function stripQueryAndFragment(value: string): string {
  const cut = value.search(QUERY_OR_FRAGMENT);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * A copy of `error` with {@link redactUrlCredentials} applied to everything a
 * subscriber can read off it — the message, the stack (V8 renders it as
 * `Name: message` followed by the frames, so the message is in there twice),
 * every own string-valued property, the `cause` chain, and the errors nested
 * inside an array property such as `AggregateError.errors`.  Enumerability is
 * preserved per property, so the copy serialises the way the original does.
 *
 * **Why a copy and not an in-place scrub.**  The `Error` belongs to the driver
 * that threw it, which may still hold the reference and may have handed it to
 * other listeners of its own; rewriting `message` under them is a side effect
 * this project has no right to cause.
 *
 * **Why not a plain wrap either.**  Replacing the error with a fresh one loses
 * the type, and the type is what a monitor branches on — `e.name`,
 * `e instanceof AmqpConnectionError`, `e.code === 'ECONNREFUSED'`.  So the copy
 * is made to answer those questions the same way the original does: it carries
 * the original's prototype, so `instanceof` still holds, and its own
 * enumerable properties, so `code` / `errno` / `syscall` survive.  What it
 * deliberately does not carry is anything reachable only through a getter —
 * a getter can recompute the secret, and a redaction that can be undone by
 * reading a property is not one.
 *
 * Redaction is a strict no-op on a message with no `scheme://…@` authority in
 * it, which is the overwhelming majority, so this costs a walk and returns an
 * equal-looking error rather than a lossy one.
 *
 * `seen` breaks a cyclic `cause` chain; callers do not pass it.
 */
export function redactErrorCredentials<E extends Error>(error: E, seen: Set<unknown> = new Set()): E {
  if (seen.has(error)) return error;
  seen.add(error);

  const copy = new Error(redactUrlCredentials(error.message)) as E;
  Object.setPrototypeOf(copy, Object.getPrototypeOf(error) as object);
  // Own property *names*, not `Object.keys`: the three fields most worth
  // redacting are all non-enumerable, so `keys` sees none of them.  `cause` is
  // non-enumerable when set through the `Error` constructor option and is the
  // field most likely to hold the driver's lower-level error; `errors` on an
  // `AggregateError` is the same; `stack` is where V8 repeats the message.
  // (`name` needs nothing here when it lives on the prototype, which came
  // across above, and is picked up by this loop when a driver sets it as an
  // own property.)
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'message') continue;                       // already redacted, above
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    // Accessor descriptors are skipped rather than invoked: a getter can
    // recompute the secret, so carrying one across would hand back a copy the
    // next property read undoes.
    if (!descriptor || !('value' in descriptor)) continue;
    Object.defineProperty(copy, key, {
      ...descriptor,
      value: redactedValue(descriptor.value, seen),
    });
  }
  return copy;
}

/**
 * One property of an error, redacted according to what it is.
 *
 * The array arm is not generality for its own sake: `AggregateError.errors` is
 * exactly this shape, and it is what Node raises when a host name resolves to
 * several addresses and every connection fails — so for a broker dialling a
 * DNS name it is the *common* case, not an exotic one, and each element
 * carries the same target string the outer message would have.
 *
 * Anything else is passed through untouched.  A redactor that reached into
 * arbitrary objects would have to decide what to do about getters and
 * prototypes on values it knows nothing about, and the only field shapes this
 * has to cover are the ones a driver actually sets.
 */
function redactedValue(value: unknown, seen: Set<unknown>): unknown {
  if (typeof value === 'string') return redactUrlCredentials(value);
  if (value instanceof Error) return redactErrorCredentials(value, seen);
  if (Array.isArray(value)) return value.map((element) => redactedValue(element, seen));
  return value;
}
