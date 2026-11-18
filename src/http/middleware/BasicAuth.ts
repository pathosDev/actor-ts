/**
 * HTTP Basic authentication middleware — the `Authorization: Basic` peer
 * of {@link BearerTokenAuth}.  Credentials are compared constant-time, and
 * a 401 advertises a real `WWW-Authenticate: Basic realm="…"` header (via
 * HttpError.headers).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Middleware } from '../Route.js';
import { HttpError, Status } from '../Types.js';
import type { BasicAuthOptions, BasicAuthOptionsType } from './BasicAuthOptions.js';

/**
 * Constant-time compare.  Both sides are reduced to SHA-256 digests first, so
 * `timingSafeEqual` always runs over two 32-byte buffers: a length pre-check
 * on the raw strings would return early whenever the lengths differ, and how
 * often it does says something about the stored secret's length.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = createHash('sha256').update(Buffer.from(a)).digest();
  const bb = createHash('sha256').update(Buffer.from(b)).digest();
  return timingSafeEqual(ab, bb);
}

/** Build a Basic-auth middleware.  Requires `users` or `validate`. */
export function BasicAuth(options: BasicAuthOptions): Middleware {
  const resolvedOptions = options as Partial<BasicAuthOptionsType>;
  const users = resolvedOptions.users;
  const validate = resolvedOptions.validate;
  if (!users && !validate) {
    throw new Error('BasicAuth: provide either users or a validate function');
  }
  const realm = resolvedOptions.realm ?? 'actor-ts';
  const challenge = { 'www-authenticate': `Basic realm="${realm}"` };
  const unauthorized = (message: string): never => {
    throw new HttpError(Status.Unauthorized, message, undefined, challenge);
  };

  return async (request, next) => {
    const header = request.headers['authorization'];
    if (!header) unauthorized('missing Authorization header');
    const match = /^Basic\s+(.+)$/i.exec(header!);
    if (!match) unauthorized('authorization scheme must be Basic');
    const decoded = Buffer.from(match![1]!.trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) unauthorized('malformed Basic credentials');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);

    let ok = false;
    if (validate) {
      ok = (await validate(user, pass)) === true;
    } else if (users) {
      // Every entry is visited (no early exit) and both halves of each entry
      // are compared before their results are combined, so an unknown user,
      // a known user with a wrong password and a valid login all run the same
      // number of comparisons.  A `safeEqual(user, u) && safeEqual(pass, p)`
      // would skip the password compare for an unknown name, and the count of
      // comparisons would say which usernames exist (#968).
      for (const [u, p] of Object.entries(users)) {
        const userMatches = safeEqual(user, u);
        const passwordMatches = safeEqual(pass, p);
        if (userMatches && passwordMatches) ok = true;
      }
    }
    if (!ok) unauthorized('invalid credentials');
    return next();
  };
}
