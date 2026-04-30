/**
 * Hardcoded test credentials for the chat sample.
 *
 * Plain-text passwords on purpose: this is a demo, the credentials
 * are printed under the login form so anyone can poke at the app.
 * **Do NOT** copy this file into production.  Replace with bcrypt /
 * argon2 hashing + a real user store.
 */

export interface TestUser {
  readonly username: string;
  readonly password: string;
  /** Used in UI for an avatar/colour.  Not part of auth. */
  readonly displayName: string;
}

export const TEST_USERS: ReadonlyArray<TestUser> = [
  { username: 'alice',   password: 'wonderland', displayName: 'Alice'   },
  { username: 'bob',     password: 'builder',    displayName: 'Bob'     },
  { username: 'charlie', password: 'chaplin',    displayName: 'Charlie' },
  { username: 'diana',   password: 'prince',     displayName: 'Diana'   },
] as const;
