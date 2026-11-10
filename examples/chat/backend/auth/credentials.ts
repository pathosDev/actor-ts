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
 * At four users that is four scrypt derivations per login; they run
 * concurrently on the runtime's thread pool (`Promise.all`), so the
 * wall-clock is one derivation's rather than four (measured 316 → 95 ms
 * on Node, 206 → 76 ms on Bun, 1159 → 297 ms on Deno, #1540) and the
 * profile stays flat — every login pays for all four, whichever
 * username it names.  For a real deployment you'd verify against a
 * fixed dummy hash on username-miss instead.
 *
 * Async because `verifyPassword` is: the derivation runs off the event
 * loop, and the caller (`UserSessionActor`) awaits this from its
 * `onReceive`, so the actor's mailbox waits while every other actor
 * in the backend keeps running.
 */
import { TEST_USERS, type TestUser } from '../../shared/users.js';
import { verifyPassword } from './password.js';

export async function validateCredentials(
  username: string,
  password: string,
): Promise<TestUser | null> {
  // verifyPassword runs for every user unconditionally so timing is
  // independent of whether the username matched.
  const verified = await Promise.all(
    TEST_USERS.map((u) => verifyPassword(password, u.passwordHash)),
  );
  let match: TestUser | null = null;
  for (const [index, u] of TEST_USERS.entries()) {
    if (verified[index] && u.username === username) match = u;
  }
  return match;
}
