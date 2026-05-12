/**
 * Credential validation against the hardcoded test-user list in
 * `shared/users.ts`.  Returns the canonical {@link TestUser} on
 * success — `null` on a bad password / unknown user.
 *
 * **Hashing** lives in `auth/password.ts` — scrypt + constant-time
 * compare.  The store still scans linearly (four users), which is
 * fine for a demo; production would index by username and pull from
 * a DB.  Brute-force protection at this layer is out of scope —
 * Fastify's rate-limit plugin handles that as middleware and is
 * documented in the chat README's "Production hardening" section.
 *
 * **Why we don't early-exit on `username !== u.username`**: scanning
 * every user and verifying against a *real* hash (even when the
 * username is wrong) gives the response a flat timing profile —
 * a bad-username response takes the same wall-clock as a bad-
 * password one.  Defends against username-enumeration via timing.
 * At four users the cost is ~40 ms of wasted scrypt; for a real
 * deployment you'd verify against a fixed dummy hash on
 * username-miss instead.
 */
import { TEST_USERS, type TestUser } from '../../shared/users.js';
import { verifyPassword } from './password.js';

export function validateCredentials(
  username: string,
  password: string,
): TestUser | null {
  let match: TestUser | null = null;
  for (const u of TEST_USERS) {
    // verifyPassword runs unconditionally so timing is independent
    // of whether the username matched.
    const ok = verifyPassword(password, u.passwordHash);
    if (ok && u.username === username) match = u;
  }
  return match;
}
