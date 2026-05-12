/**
 * Hardcoded test credentials for the chat sample.
 *
 * **Production-realistic auth** (since #99):
 *   - `passwordHash` is `<salt-hex>:<hash-hex>` using Node's built-in
 *     `crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 })`.
 *     scrypt is memory-hard like bcrypt/argon2; a leaked store can't
 *     be brute-forced on commodity hardware.  Verification lives in
 *     `backend/auth/password.ts` and uses `crypto.timingSafeEqual`
 *     for constant-time compare.
 *   - The plain-text passwords are still listed below as comments so
 *     anyone can poke at the demo via the login form (which prints
 *     them too — see `static/plain/index.html` and each frontend's
 *     `.creds` block).  **Production would not have this**; you'd
 *     pull users from a database and never know the plaintexts at
 *     all.  The list-of-four shape exists because the sample's user
 *     model is "hardcoded for predictability", not because hashed
 *     storage somehow requires it.
 *
 * `displayName` is purely cosmetic — used for avatar colours in
 * frontends that bother.  Not part of authentication.
 */

export interface TestUser {
  readonly username: string;
  /**
   * `<salt-hex>:<hash-hex>` — scrypt output.  Verified via
   * `verifyPassword` in `backend/auth/password.ts`.
   */
  readonly passwordHash: string;
  readonly displayName: string;
}

export const TEST_USERS: ReadonlyArray<TestUser> = [
  {
    username: 'alice',
    // plain: 'wonderland'
    passwordHash: 'babce1ac8ce53093925de96ff531eafb:0c0582c625ac6c147eed069b31edb03cba007c7497ba8976b15efcf6bd65f744',
    displayName: 'Alice',
  },
  {
    username: 'bob',
    // plain: 'builder'
    passwordHash: 'aadcf0a512c40a869e35b9d95c9bff60:879ab1afeee355e42ba0c9dd5abdc74afad821f1a41b425dedaddfe6d878adea',
    displayName: 'Bob',
  },
  {
    username: 'charlie',
    // plain: 'chaplin'
    passwordHash: '6e83d16b8c690aaee9b8804d228f495d:3390ca9b9ac0f6331b01ad991ae55ca286497d10afbbb14c610dcfd76faf6b8d',
    displayName: 'Charlie',
  },
  {
    username: 'diana',
    // plain: 'prince'
    passwordHash: '550930c8125d163ea19357ee070c4f0d:c994a66d16bdc1d1cb6554d3b625a4347f051cdfb21a5548008784948a5b702f',
    displayName: 'Diana',
  },
] as const;
