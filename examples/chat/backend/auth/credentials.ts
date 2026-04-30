/**
 * Credential validation against the hardcoded test-user list in
 * `shared/users.ts`.  Returns the canonical {@link TestUser} on
 * success — `null` on a bad password / unknown user.
 *
 * Real production code would:
 *   - Hash + verify with bcrypt / argon2.
 *   - Pull users from a database, not a TS literal.
 *   - Add brute-force protection (rate-limiting).
 *   - Use a constant-time compare.
 *
 * For a sample, the in-memory linear scan is fine: four users.
 */
import { TEST_USERS, type TestUser } from '../../shared/users.js';

export function validateCredentials(
  username: string,
  password: string,
): TestUser | null {
  for (const u of TEST_USERS) {
    if (u.username === username && u.password === password) return u;
  }
  return null;
}
