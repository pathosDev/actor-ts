/**
 * HTTP Basic authentication middleware — the `Authorization: Basic` peer
 * of {@link BearerTokenAuth}.  Credentials are compared constant-time, and
 * a 401 advertises a real `WWW-Authenticate: Basic realm="…"` header (via
 * HttpError.headers).
 */
import { timingSafeEqual } from 'node:crypto';
import type { Middleware } from '../Route.js';
import { HttpError, Status } from '../types.js';
import type { BasicAuthOptions, BasicAuthOptionsType } from './BasicAuthOptions.js';

/** Constant-time compare (equal length only — the length pre-check is the one known leak). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Build a Basic-auth middleware.  Requires `users` or `validate`. */
export function BasicAuth(options: BasicAuthOptions): Middleware {
  const o = options as Partial<BasicAuthOptionsType>;
  const users = o.users;
  const validate = o.validate;
  if (!users && !validate) {
    throw new Error('BasicAuth: provide either users or a validate function');
  }
  const realm = o.realm ?? 'actor-ts';
  const challenge = { 'www-authenticate': `Basic realm="${realm}"` };
  const unauthorized = (message: string): never => {
    throw new HttpError(Status.Unauthorized, message, undefined, challenge);
  };

  return async (req, next) => {
    const header = req.headers['authorization'];
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
      // Iterate every entry (no early exit) so timing doesn't reveal which
      // usernames exist; a miss still burns the same comparisons.
      for (const [u, p] of Object.entries(users)) {
        if (safeEqual(user, u) && safeEqual(pass, p)) ok = true;
      }
    }
    if (!ok) unauthorized('invalid credentials');
    return next();
  };
}
