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
 * **Why a regex rather than a `URL` round-trip** for the first one: blanking
 * `username`/`password` on a parsed `URL` and reading `href` back also
 * lowercases the host, appends a trailing slash and re-encodes the path, so
 * an operator can fail to recognise the value they just mistyped — and the
 * non-special schemes this project speaks (`mqtt:`, `amqp:`, `redis:`,
 * `libsql:`) parse differently across the WHATWG implementations in Bun,
 * Node and Deno.  A regex also stays a strict no-op on the inputs that are
 * not URLs at all (`':memory:'`, `'file:local.db'`, `'not a url'`), which is
 * what keeps it safe to apply unconditionally on an error path.
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

/**
 * Userinfo of an absolute URL: a scheme, `://`, then everything up to the
 * last `@` that is still inside the authority.
 *
 * The character class excludes `/`, `?` and `#`, which is what bounds the
 * match to the authority — an `@` in a path (`redis://host/a@b`) is not
 * userinfo and must survive.  Greedy up to that boundary so the *last* `@`
 * wins, matching how WHATWG splits an authority when the password itself
 * contains an unescaped `@`.
 *
 * Global, so a joined server list (`nats://a:b@h1,nats://c:d@h2` — see
 * `NatsActor`) is covered in full; `//` cannot be crossed by the class, so
 * the entries cannot bleed into one another.
 */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/g;

/** First query or fragment delimiter — everything from here is dropped. */
const QUERY_OR_FRAGMENT = /[?#]/;

/**
 * Replace the userinfo of every absolute URL in `value` with `***`, leaving
 * the rest of the string byte-identical.
 *
 * A no-op on anything without a `scheme://…@` authority, so it is safe to
 * apply to a value that only might be a URL.
 */
export function redactUrlCredentials(value: string): string {
  return value.replace(URL_USERINFO, `$1${USERINFO_MASK}@`);
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
