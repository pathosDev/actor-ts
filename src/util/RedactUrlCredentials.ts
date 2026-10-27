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
 * `username` and `password` instead, and leaves the scan only what follows
 * its host (found while #1458).
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
 * `#` to the last `@` before the next `://`, on its own line or past a line
 * break that no space or tab follows —
 * `(?:(?!://)[^\r\n])*(?:[\r\n](?:(?!://)[^ \t])*)?@` with its backtracking
 * written out, in {@link lastAtBeforeNextUrl} — because ending it at the first
 * of the three printed every password that contained one.
 * `tests/unit/util/RedactUrlCredentials.test.ts` keeps that pattern as an
 * oracle and compares the two over generated input, because what this
 * function redacts is public API (`src/index.ts`) — and keeps the original
 * one too, to show the move only ever masks further on a line of its own.
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

/** The characters the scans turn on, as code points. */
const AT_SIGN = 0x40;
const COLON = 0x3a;
const COMMA = 0x2c;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const QUESTION_MARK = 0x3f;
const NUMBER_SIGN = 0x23;
const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** First query or fragment delimiter — everything from here is dropped. */
const QUERY_OR_FRAGMENT = /[?#]/;

/**
 * The schemes WHATWG calls *special*: their authority also ends at a `\`, and
 * any run of `/` and `\` after the `:` is skipped before it begins.
 */
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set(['ftp', 'file', 'http', 'https', 'ws', 'wss']);

/**
 * Where one userinfo lies in a value: `value.slice(start, end)` is what the
 * mask replaces, and `end` is the index of the `@` behind it.
 */
type UserinfoSpan = {
  readonly start: number;
  readonly end: number;
  /** The scheme in front of it, or `null` for the userinfo a scheme-less list entry begins with. */
  readonly scheme: string | null;
};

/**
 * Replace the userinfo of every absolute URL in `value` with `***`, leaving
 * the rest of the string byte-identical.
 *
 * A no-op on anything without a `scheme://…@` in it, so it is safe to apply to
 * a value that only might be a URL.  The userinfo runs to the last `@` before
 * the next `://` on its line, so a password with an unescaped `/`, `?` or `#`
 * in it is masked whole and the next line of a stack is left alone — see
 * {@link lastAtBeforeNextUrl} for that reading and its price.  Every URL in
 * the string is covered, not just the first: a joined
 * server list (`nats://a:b@h1,nats://c:d@h2` — see `NatsActor`) has each
 * entry masked, and the entries cannot bleed into one another because a
 * userinfo stops at the `://` that opens the next one.
 */
export function redactUrlCredentials(value: string): string {
  const spans = schemeUserinfoSpans(value);
  if (spans.length === 0) return value;
  // Written out rather than accumulated with `+=`: the pieces are slices of
  // one string, and joining them once keeps the copying proportional to the
  // output instead of to the number of matches.
  const pieces: string[] = [];
  let copiedTo = 0;
  for (const span of spans) {
    pieces.push(value.slice(copiedTo, span.start), USERINFO_MASK);
    // Resume *at* the `@`: it is part of the output.
    copiedTo = span.end;
  }
  pieces.push(value.slice(copiedTo));
  return pieces.join('');
}

/**
 * The userinfo behind every `scheme://` in `value`, in order: the matches of
 * {@link redactUrlCredentials}, as positions rather than as a rewritten string,
 * so the label can decide per match what else it may show.
 */
function schemeUserinfoSpans(value: string): UserinfoSpan[] {
  const spans: UserinfoSpan[] = [];
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
    spans.push({ start: authorityStart, end: userinfoEnd, scheme: schemeBefore(value, separator) });
    // The next authority cannot start before the `@`.
    searchFrom = userinfoEnd + 1;
  }
  return spans;
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
 * *Where* in the run the scheme begins is not computed here: the scan copies
 * the scheme through verbatim either way, so it cannot change the output.
 * Walking backwards and stopping at the first letter is what makes this
 * bounded by the run rather than by the string.  No length cap — RFC 3986
 * does not impose one, and a 300-character scheme still redacts.
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
 * The scheme the `://` at `separator` closes, lowercased: the run of scheme
 * characters in front of it, from the first letter on — where the grammar's
 * match begins.  Only called where {@link precededByScheme} holds, so the run
 * has a letter.  Bounded by the run, which ends at a character no scheme may
 * hold, so two separators never walk the same characters.
 */
function schemeBefore(value: string, separator: number): string {
  let start = separator;
  while (start > 0 && isSchemeCharacter(value.charCodeAt(start - 1))) start--;
  while (!isSchemeStart(value.charCodeAt(start))) start++;
  return value.slice(start, separator).toLowerCase();
}

/**
 * Index of the last `@` between `from` and the next `://` (or the end of
 * `value`, or the first space or tab after a line break), or `-1`: where a
 * userinfo that begins at `from` ends.
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
 * opposite error prints a password.  The `***` stays in the output, so a
 * reader can tell that what follows it is what followed the last `@` — the
 * label, which would otherwise present it as a host, names none instead (see
 * {@link labelReach}).
 *
 * The next `://` is the one bound kept, and a `,` is no bound at all.  The
 * next `://` is where the next URL of a joined list or a log line begins
 * (`nats://a:b@h1,nats://c:d@h2`), and running past it would mask the first
 * entry's host together with the second entry's userinfo.  It is also what
 * keeps the scan linear.  A comma in front of an `@` may be part of the
 * password (`amqp://user:a,b@host`), and so may a comma *behind* one
 * (`amqp://user:a@b,c@host` is byte for byte a credentialed list): v0.17.0
 * read both as one userinfo, as WHATWG does, and ending the userinfo at a
 * comma once an `@` had been seen printed `b` (#1458).
 *
 * **A line break bounds it, once text follows.**  Run on to the next `://`,
 * the scan crossed into the next line of an error's stack, and every frame of
 * a driver from a scoped package (`/app/node_modules/@nats-io/…`) carries an
 * `@`: a credential-free stack came back with its target and its first frame
 * folded into one `***`, where the first frame's `/` used to end the scan.  A
 * line break is no part of a URL — RFC 3986 forbids one and WHATWG drops it
 * before parsing — but it is part of a secret read from a file, whose
 * trailing newline lands in front of the `@` (`user:s3cr3t\n@host`).  So the
 * scan goes on past a line break and stops at the first space or tab after
 * it, which is where a stack frame and a line of prose begin and where a
 * pasted secret does not.  A credential that holds a line break *and* a later
 * space or tab is the one shape this gives up, and the one v0.17.0 masked —
 * where no `/`, `?` or `#` came first — that this does not.
 */
function lastAtBeforeNextUrl(value: string, from: number): number {
  let found = -1;
  let pastLineBreak = false;
  for (let index = from; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === AT_SIGN) found = index;
    else if (code === LINE_FEED || code === CARRIAGE_RETURN) pastLineBreak = true;
    else if (pastLineBreak && (code === SPACE || code === TAB)) break;
    else if (code === COLON && value.startsWith(SCHEME_SEPARATOR, index)) break;
  }
  return found;
}

/**
 * `url` as its own `href`, with the username and the password replaced by
 * `***` — exactly those two, found by length rather than by a search.
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
 * What follows the host — path, query, fragment — still goes through
 * {@link redactUrlCredentials}.  A URL written into it
 * (`?target=http://user:pass@inner/x`) is text the parsed one carries, and
 * nothing split that text's userinfo from its host: masking only the outer
 * credential would print the inner one whole, which the scan never did.  An
 * `@` with no `://` in front of it, as in the registry path above, the scan
 * leaves alone.
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
  const href = url.href;
  // No `//` after the scheme means no authority and so no credential
  // (`mailto:`, `data:`): everything after the scheme is path.
  if (!href.startsWith('//', url.protocol.length)) {
    return `${url.protocol}${redactUrlCredentials(href.slice(url.protocol.length))}`;
  }
  // `href` spells the userinfo exactly as the two getters do, straight after
  // `scheme://`, and the host exactly as `host` does, straight after that —
  // so both ends are known by length.  Searching for the `@` instead would
  // meet one a path or a query is free to carry.
  const authorityStart = url.protocol.length + 2;
  const userinfo = url.password === '' ? url.username : `${url.username}:${url.password}`;
  const hostStart = userinfo === '' ? authorityStart : authorityStart + userinfo.length + 1;
  const hostEnd = hostStart + url.host.length;
  const credential = userinfo === '' ? '' : `${USERINFO_MASK}@`;
  return `${href.slice(0, authorityStart)}${credential}${href.slice(hostStart, hostEnd)}`
    + redactUrlCredentials(href.slice(hostEnd));
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
 * **The label shows no credential the v0.17.0 label kept out, and names no
 * host that is not the URL's own.**  Three rules, in this order:
 *
 *   1. *Every userinfo is masked before anything is parsed or cut,* by the
 *      scan of {@link redactUrlCredentials} — to the last `@` before the next
 *      `://`, across `/`, `?`, `#` and commas, since a pasted password carries
 *      all four (#1458).  A list entry that does not begin with a `scheme://`
 *      is masked to its own last `@`: `user:password@host`, the server form
 *      memjs takes and nats.js accepts, which WHATWG would read as the scheme
 *      `user:` and printed as `user://password@host`.
 *   2. *Nothing behind the first `?` or `#` is shown.*  A query is where a
 *      token goes when the userinfo does not carry one, and v0.17.0 never
 *      printed one.  When that `?` or `#` lies inside a masked userinfo — a
 *      password that carries it, or a query token with an `@` in it, which
 *      read the same — the label ends at the `***`.
 *   3. *A host is named only if every reading agrees on it.*  When a masked
 *      userinfo contains a `/` in front of which WHATWG reads a valid
 *      authority (`https://host/a@b`, `amqp://user:12/PW1@host`), the same
 *      bytes are a URL for that authority with an `@` in its path, and also a
 *      password ending in `/a` or `/PW1`: the host behind the `@` is wrong for
 *      the first reading and the one in front of the `/` is a password for the
 *      second, so the label ends at the `***` and names neither.  Where
 *      WHATWG reads no valid authority there (`user:pa/PW1@host` — `pa` is no
 *      port) the scan's reading is the only one, and its host is named.  A
 *      userinfo in which a host stands in front of a comma may have taken
 *      earlier entries of a list with it (`nats://u:p@h1,v:q@h2` is one URL to
 *      WHATWG and two to a server list), so its `***@` stays in the label;
 *      `user:a` in `amqp://user:a,b@host` is no host, and that comma is the
 *      password's.
 *
 * **Only a value that is unambiguously one URL is rebuilt from its parse** —
 * it begins with `scheme://`, holds no `,` and no second `://`, and every mask
 * in it hid a userinfo only.  Two shapes reach this function as a matter of
 * course through `BrokerActor`'s lifecycle events and are not one: the
 * scheme-less entry above, and a joined server list, which the parser can
 * take for one URL with the rest of the list for a path
 * (`nats://u:p1@h1,nats://u:p2@h2` is the host `h1,nats` and the path
 * `//u:p2@h2`, and the `nats://` the JetStream actors put in front of a list
 * does the same with no comma at all).  Those are cut instead, the list as a
 * whole, since a query is free to contain commas.  A masked entry keeps `***`
 * where its credential was (`***@h1:4222`), and the list keeps its shape, so
 * an operator still sees which servers it names.  A value with no credential
 * anywhere (`<unknown>`, `localhost:4222`) comes back as it is, minus any
 * query, so the function stays total.
 */
export function redactedUrlLabel(value: string): string {
  const spans = labelSpans(value);
  const end = labelEnd(value, spans);
  const pieces: string[] = [];
  let copiedTo = 0;
  let rebuildable = true;
  for (const span of spans) {
    if (span.start >= end) break;
    pieces.push(value.slice(copiedTo, span.start), USERINFO_MASK);
    // A label that ends inside or at the end of this mask shows nothing after it.
    copiedTo = Math.min(span.end, end);
    if (span.reach !== 'userinfo') rebuildable = false;
  }
  pieces.push(value.slice(copiedTo, end));
  const label = pieces.join('');
  const parsed = rebuildable ? parsedSingleUrl(label) : null;
  // Built field by field rather than from `origin`: for the non-special
  // schemes this project speaks (`mqtt:`, `amqp:`, `ws:` is special but
  // `libsql:` is not) WHATWG defines `origin` as the string `'null'`.
  return parsed === null ? label : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/**
 * What a masked userinfo of a label may have covered besides a credential,
 * and so what the label may still show around it — see the three rules of
 * {@link redactedUrlLabel}.
 *
 *   - `userinfo`: a credential only.  A single URL rebuilt from its parse
 *     drops it; a list entry keeps its `***@`.
 *   - `entries`: a comma inside it may have ended an entry of a list, so
 *     earlier hosts may be under it; its `***@` always stays.
 *   - `host`: under another reading of the same bytes, the URL's host or its
 *     query is under it or behind it; the label ends at its `***`.
 */
type LabelReach = 'userinfo' | 'entries' | 'host';

/** A masked userinfo of a label: where it lies, as in {@link UserinfoSpan}, and its {@link LabelReach}. */
type LabelSpan = {
  readonly start: number;
  readonly end: number;
  readonly reach: LabelReach;
};

/**
 * Every userinfo the label masks, in order: the scan's, behind each
 * `scheme://`, and the one a scheme-less list entry begins with.
 *
 * The entries are the stretches between commas that no scan match covers — a
 * comma inside a masked userinfo is part of it, which is the fix for a
 * password with a comma in it (#1458).  An entry's own userinfo runs to its
 * last `@` before its first `://`, and starts after the space a `, ` join
 * leaves, so the list keeps its shape.  Scanned once, front to back: an
 * entry's search stops at its end, never at the end of the value.
 */
function labelSpans(value: string): LabelSpan[] {
  const schemeSpans = schemeUserinfoSpans(value);
  const spans: LabelSpan[] = [];
  let next = 0;
  let entryStart = 0;
  for (let index = 0; index <= value.length; index++) {
    // Skip a scan match whole: a comma inside it is not a separator.
    const covering = schemeSpans[next];
    if (covering !== undefined && index === covering.start) {
      spans.push({ start: covering.start, end: covering.end, reach: labelReach(value, covering) });
      index = covering.end;
      next++;
      continue;
    }
    if (index < value.length && value.charCodeAt(index) !== COMMA) continue;
    const entryUserinfo = schemeLessUserinfo(value, entryStart, index);
    if (entryUserinfo !== null) {
      spans.push({ start: entryUserinfo.start, end: entryUserinfo.end, reach: labelReach(value, entryUserinfo) });
    }
    entryStart = index + 1;
  }
  return spans.sort((left, right) => left.start - right.start);
}

/**
 * The userinfo the list entry `value.slice(from, to)` begins with when no
 * `scheme://` opens it — up to its last `@` in front of its first `://` — or
 * `null`.  An entry a `scheme://` opens finds no `@` in front of that `://`.
 *
 * The last `@`, by the same rule as a userinfo behind a scheme: a `/`, `?`,
 * `#` or `@` in front of it is part of the password, not the end of it
 * (#1458).  That reading is wrong for an e-mail address
 * (`mailto:ops@example.com` keeps only `***@example.com`), which costs a label
 * nothing it needs; the opposite error prints a password.  A comma in such a
 * password is out of reach: with no `://` to say where the userinfo begins,
 * the comma reads as the list separator it usually is, so `user:a,b@host` is
 * labelled `user:a,***@host`.
 */
function schemeLessUserinfo(value: string, from: number, to: number): UserinfoSpan | null {
  let start = from;
  while (start < to && value.charCodeAt(start) === SPACE) start++;
  let found = -1;
  for (let index = start; index < to; index++) {
    const code = value.charCodeAt(index);
    if (code === AT_SIGN) found = index;
    else if (code === COLON && value.startsWith(SCHEME_SEPARATOR, index)) break;
  }
  return found === -1 ? null : { start, end: found, scheme: null };
}

/**
 * The {@link LabelReach} of the userinfo `span` masks.
 *
 * A `?` or `#` inside it reaches the query.  Otherwise what matters is
 * whether another reading of the same bytes puts a host inside it: a stretch
 * that starts the span (no credential at all), follows an `@` inside it (a
 * shorter credential) or follows a comma (the next entry of a list), runs to a
 * delimiter, and is a host and port WHATWG accepts.
 *
 *   - Ended by a `/` — or a `\`, which a special scheme's authority also ends
 *     at — such a stretch makes the bytes a URL for that host with an `@` in
 *     its path, not only a password: it reaches the host.
 *   - Ended by a comma, it is an entry of a list whose next entry the comma
 *     starts: it reaches earlier entries.  A stretch that is no host — `user:a`
 *     in `amqp://user:a,b@host`, where `a` is no port — makes the comma part of
 *     the password, and the mask hid a userinfo only.
 *
 * A stretch that follows a `/` is path under every reading and is no host.
 * WHATWG skips any `/` and `\` a special scheme's authority starts with, and so
 * does this.  Every byte of the span is visited once and belongs to at most
 * one stretch, so the parses together cost no more than the span.
 */
function labelReach(value: string, span: UserinfoSpan): LabelReach {
  const special = span.scheme !== null && SPECIAL_SCHEMES.has(span.scheme);
  let hostStart = span.start;
  while (special && hostStart < span.end && isSlashOrBackslash(value.charCodeAt(hostStart))) hostStart++;
  let entries = false;
  for (let index = hostStart; index < span.end; index++) {
    const code = value.charCodeAt(index);
    if (code === QUESTION_MARK || code === NUMBER_SIGN) return 'host';
    if (code === AT_SIGN) {
      hostStart = index + 1;
    } else if (code === COMMA) {
      if (hostStart !== -1 && parsesAsHost(span.scheme, value.slice(hostStart, index).trimStart())) entries = true;
      hostStart = index + 1;
    } else if (code === SLASH || (special && code === BACKSLASH)) {
      if (hostStart !== -1 && parsesAsHost(span.scheme, value.slice(hostStart, index).trimStart())) return 'host';
      hostStart = -1;
    }
  }
  return entries ? 'entries' : 'userinfo';
}

/** `/` or `\`. */
function isSlashOrBackslash(code: number): boolean {
  return code === SLASH || code === BACKSLASH;
}

/**
 * Whether WHATWG accepts `host` as the host and port of a URL with `scheme`
 * (a scheme-less entry is tried under one that is not special).  An empty
 * host passes where WHATWG allows one, as it does for a scheme that is not
 * special: such a URL names no host, so nothing behind it may be named for it.
 */
function parsesAsHost(scheme: string | null, host: string): boolean {
  try {
    new URL(`${scheme ?? 'x'}${SCHEME_SEPARATOR}${host}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the label ends: at the first `?` or `#` of `value`, or at the end of
 * the first mask that reaches the host, whichever comes first.
 */
function labelEnd(value: string, spans: readonly LabelSpan[]): number {
  const queryOrFragment = value.search(QUERY_OR_FRAGMENT);
  const end = queryOrFragment === -1 ? value.length : queryOrFragment;
  for (const span of spans) {
    if (span.start >= end) break;
    if (span.reach === 'host') return Math.min(end, span.end);
  }
  return end;
}

/**
 * `label` parsed as a URL when it is unambiguously one, otherwise `null`:
 * it begins with `scheme://`, so there is an authority to route userinfo out
 * of (an opaque path has none), and holds neither a `,` nor a second `://`,
 * either of which means a list entry or another URL follows the first
 * authority.  The label arrives masked and cut, so a misreading costs it its
 * shape at worst — a list taken for one URL with the rest for a path — and a
 * `,` inside a single URL's path costs that URL only its normalisation.
 */
function parsedSingleUrl(label: string): URL | null {
  const authorityStart = authorityStartOf(label);
  if (authorityStart === -1) return null;
  if (label.includes(LIST_SEPARATOR)) return null;
  if (label.includes(SCHEME_SEPARATOR, authorityStart)) return null;
  try {
    return new URL(label);
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
