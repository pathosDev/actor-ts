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
 * and the authority after it are both delimited by characters the other side
 * cannot contain, so no two candidates can scan the same character twice.
 *
 * The grammar is unchanged — {@link isSchemeStart} and
 * {@link isSchemeCharacter} are that character class, and
 * {@link lastAtInAuthority} is `[^/?#]*@` with its backtracking written out.
 * `tests/unit/util/RedactUrlCredentials.test.ts` keeps the original pattern
 * as an oracle and compares the two over generated input, because what this
 * function redacts is public API (`src/index.ts`).
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

/** The delimiters the scan turns on, as code points. */
const AT_SIGN = 0x40;
const SLASH = 0x2f;
const QUESTION_MARK = 0x3f;
const NUMBER_SIGN = 0x23;

/** First query or fragment delimiter — everything from here is dropped. */
const QUERY_OR_FRAGMENT = /[?#]/;

/**
 * Replace the userinfo of every absolute URL in `value` with `***`, leaving
 * the rest of the string byte-identical.
 *
 * A no-op on anything without a `scheme://…@` authority, so it is safe to
 * apply to a value that only might be a URL.  Every URL in the string is
 * covered, not just the first: a joined server list
 * (`nats://a:b@h1,nats://c:d@h2` — see `NatsActor`) has each entry masked,
 * and the entries cannot bleed into one another because an authority stops
 * at the `/` that opens the next one.
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
    const userinfoEnd = lastAtInAuthority(value, authorityStart);
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
 * Index of the last `@` in the authority beginning at `from`, or `-1`.
 *
 * The authority ends at the first `/`, `?` or `#`, which is what keeps an
 * `@` in a path (`redis://host/a@b`) or a query out of it.  The *last* one
 * inside wins, matching how WHATWG splits an authority whose password
 * contains an unescaped `@`.
 */
function lastAtInAuthority(value: string, from: number): number {
  let found = -1;
  for (let index = from; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === SLASH || code === QUESTION_MARK || code === NUMBER_SIGN) break;
    if (code === AT_SIGN) found = index;
  }
  return found;
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
 * operator typed.  An unparseable value falls back to a userinfo-masked,
 * query-stripped copy of the input, so the function is total.
 */
export function redactedUrlLabel(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return stripQueryAndFragment(redactUrlCredentials(value));
  }
  // Built field by field rather than from `origin`: for the non-special
  // schemes this project speaks (`mqtt:`, `amqp:`, `ws:` is special but
  // `libsql:` is not) WHATWG defines `origin` as the string `'null'`.
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** Cut at the first `?` or `#`; returns `value` unchanged when it has neither. */
function stripQueryAndFragment(value: string): string {
  const cut = value.search(QUERY_OR_FRAGMENT);
  return cut === -1 ? value : value.slice(0, cut);
}
