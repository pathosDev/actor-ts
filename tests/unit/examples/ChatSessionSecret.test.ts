import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionStore } from '../../../examples/chat/backend/auth/sessionStore.js';
import type { DistributedDataHandle } from '../../../src/crdt/DistributedData.js';

/**
 * Regression test for #791 — the chat sample's session store must
 * refuse to start on a secret nobody chose.
 *
 * Why this is worth a test in a framework repository: the sample is
 * the flagship full-stack example, so its auth module is what an
 * adopter copies.  It used to substitute a constant published in its
 * own source when `CHAT_TOKEN_SECRET` was absent and log a warning —
 * a fail-open shape, where a forgotten variable produces a running,
 * apparently-correct authentication system whose signing key is
 * public.  The tokens are self-validating, so that key is the only
 * thing standing between a stranger and an arbitrary identity.
 *
 * The three properties below are separable and each is easy to break
 * while "fixing" this:
 *
 *  1. no secret and no opt-in must throw (the fix itself);
 *  2. the opt-in must be explicit — a truthiness check on the raw
 *     variable would let `CHAT_ALLOW_DEMO_SECRET=0` enable it;
 *  3. an empty secret must count as unset — an `=== undefined` check
 *     would key the HMAC on zero bytes, which is worse than the
 *     published constant.
 *
 * The store's constructor only stashes the handle, so a stub that can
 * answer the one revocation read `lookupToken` performs is enough; no
 * cluster, no DistributedData actor.
 */

const TOKEN_SECRET_VARIABLE = 'CHAT_TOKEN_SECRET';
const DEMO_SECRET_OPT_IN_VARIABLE = 'CHAT_ALLOW_DEMO_SECRET';

/** Nothing is ever revoked here, so an empty view is the whole stub. */
const distributedData = { get: () => undefined } as unknown as DistributedDataHandle;

describe('chat sample session secret (#791)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    // The machine running this may export either variable; a suite that
    // inherited one would pass for a reason unrelated to the code.
    for (const name of [TOKEN_SECRET_VARIABLE, DEMO_SECRET_OPT_IN_VARIABLE]) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  test('an unset secret with no opt-in fails construction', () => {
    expect(() => new SessionStore(distributedData)).toThrow(/CHAT_TOKEN_SECRET is not set/);
  });

  test('the error names both ways out, so the message is actionable', () => {
    let message = '';
    try {
      new SessionStore(distributedData);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(TOKEN_SECRET_VARIABLE);
    expect(message).toContain(`${DEMO_SECRET_OPT_IN_VARIABLE}=1`);
  });

  test('an empty secret counts as unset rather than as a zero-byte key', () => {
    process.env[TOKEN_SECRET_VARIABLE] = '';
    expect(() => new SessionStore(distributedData)).toThrow(/CHAT_TOKEN_SECRET is not set/);
    // Same rule for the constructor argument, which is the seam tests use.
    delete process.env[TOKEN_SECRET_VARIABLE];
    expect(() => new SessionStore(distributedData, '')).toThrow(/CHAT_TOKEN_SECRET is not set/);
  });

  test('a configured secret starts, and does not claim the demo secret', () => {
    process.env[TOKEN_SECRET_VARIABLE] = 'a-strong-random-value';
    const store = new SessionStore(distributedData);
    expect(store.usingDemoSecret).toBe(false);
  });

  test('a constructor-supplied secret needs no environment at all', () => {
    const store = new SessionStore(distributedData, 'a-strong-random-value');
    expect(store.usingDemoSecret).toBe(false);
  });

  test('the explicit opt-in starts, and says it is on the demo secret', () => {
    process.env[DEMO_SECRET_OPT_IN_VARIABLE] = '1';
    const store = new SessionStore(distributedData);
    expect(store.usingDemoSecret).toBe(true);
    // The opt-in path is still a working demo — the point of the change
    // is which runs reach it, not that it stops minting tokens.
    const token = store.mintToken('alice');
    expect(store.lookupToken(token)).toBe('alice');
  });

  test('`true` opts in as well, so the variable reads naturally', () => {
    process.env[DEMO_SECRET_OPT_IN_VARIABLE] = 'True';
    expect(new SessionStore(distributedData).usingDemoSecret).toBe(true);
  });

  test('values that read as "off" do not opt in', () => {
    for (const value of ['0', 'false', 'no', '', ' ']) {
      process.env[DEMO_SECRET_OPT_IN_VARIABLE] = value;
      expect(() => new SessionStore(distributedData))
        .toThrow(/CHAT_TOKEN_SECRET is not set/);
    }
  });

  test('an explicit secret is what actually keys the signature', () => {
    // Guards against a "fix" that satisfies the checks above and then
    // signs with the fallback anyway: a token minted under one secret
    // must not verify under another.
    const minted = new SessionStore(distributedData, 'secret-one').mintToken('alice');
    expect(new SessionStore(distributedData, 'secret-one').lookupToken(minted)).toBe('alice');
    expect(new SessionStore(distributedData, 'secret-two').lookupToken(minted)).toBeNull();
  });

  test('an empty secret on the OPT-IN path keys the demo secret, not zero bytes', () => {
    // Property 3 of the header, on the path where it was never checked.  The
    // three tests above reach the empty-secret rule through the throw, so they
    // only ever exercise it with the opt-in OFF.  With the opt-in on there is
    // no throw, and what the constructor does with `''` becomes visible: the
    // fallback expression has to treat it as unset the same way the guard
    // above it does, or the run signs its tokens with a zero-byte HMAC key.
    //
    // Read without reaching for the private constant: a store that fell back
    // correctly signs identically to one that reached the fallback with the
    // variable absent, so a token minted by one verifies in the other.  Under
    // a fallback that accepts `''` the two key differently and it does not.
    process.env[DEMO_SECRET_OPT_IN_VARIABLE] = '1';
    delete process.env[TOKEN_SECRET_VARIABLE];
    const absent = new SessionStore(distributedData);
    process.env[TOKEN_SECRET_VARIABLE] = '';
    const empty = new SessionStore(distributedData);

    expect(absent.usingDemoSecret).toBe(true);
    expect(empty.usingDemoSecret).toBe(true);
    expect(
      empty.lookupToken(absent.mintToken('alice')),
      'the empty variable keyed the HMAC on something other than the demo secret',
    ).toBe('alice');
    expect(absent.lookupToken(empty.mintToken('bob'))).toBe('bob');
  });

  test('an empty constructor argument falls through to the environment', () => {
    // The `secret !== ''` half of the same rule, which the tests above cannot
    // see: they check that `''` does not COUNT as a secret, and this checks
    // what happens next — the environment is still consulted, exactly as it
    // is for an argument that was never passed.  Reverting the expression to
    // the pre-#791 `secret ?? process.env[…]` keeps every other test green
    // (the throw at the end covers the empty case on its own) and silently
    // keys this store on zero bytes instead of on the environment's secret.
    process.env[TOKEN_SECRET_VARIABLE] = 'the-environments-secret';
    const fromEmptyArgument = new SessionStore(distributedData, '');
    expect(fromEmptyArgument.usingDemoSecret).toBe(false);
    const minted = fromEmptyArgument.mintToken('alice');
    expect(new SessionStore(distributedData, 'the-environments-secret').lookupToken(minted))
      .toBe('alice');
  });

  test('the opt-in tolerates the whitespace an env file leaves around a value', () => {
    // `.trim()` in `demoSecretAllowed`, which the "off" list cannot reach: its
    // only whitespace value is `' '`, and that fails the equality check with
    // or without a trim.  The direction that matters is the other one — a
    // `.env` line written `CHAT_ALLOW_DEMO_SECRET= 1` is an opt-in whoever
    // typed it meant, and dropping the trim turns it into a start-up failure
    // whose message is about a variable they did set.
    for (const value of [' 1 ', '\t1', 'true\n', ' TRUE ']) {
      process.env[DEMO_SECRET_OPT_IN_VARIABLE] = value;
      expect(
        () => new SessionStore(distributedData),
        `${JSON.stringify(value)} should read as an opt-in`,
      ).not.toThrow();
    }
  });
});

/**
 * The startup warning in `examples/chat/backend/main.ts`.
 *
 * Read out of the source, deliberately, and it is the weaker of the two kinds
 * of assertion in this file — so it is worth saying exactly why there is no
 * stronger one available.  `main.ts` is a cluster entry point: it joins a
 * cluster, attaches DevTools and binds an HTTP server on import, so there is
 * no seam to call.  It *is* executed under `bun run test:examples`, which
 * spawns this backend with `CHAT_ALLOW_DEMO_SECRET=1` (see the chat case in
 * `tests/examples/examples.manifest.json`), but that runner asserts one
 * substring per case and the chat case spends it on the smoke test's own
 * verdict.  So the warning runs in CI with nothing looking at it, and
 * replacing its condition with `false` moved no test.
 *
 * What is asserted here is the pair the fix delivered: that the emission is
 * gated on the store's own verdict rather than on a second reading of the
 * environment, and that the line says the four things that make it actionable.
 * The wording it replaced — "session tokens signed with the demo fallback
 * secret — set CHAT_TOKEN_SECRET to a strong random string for production" —
 * carries one of the four, which is what makes these substrings a check and
 * not a transcription.
 */
describe('chat sample startup warning (#791)', () => {
  const source = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'examples', 'chat', 'backend', 'main.ts'),
    'utf8',
  );

  test('the warning is gated on the store’s own verdict', () => {
    // `sessions.usingDemoSecret`, not a second read of the environment: the
    // store decides which secret it ended up with, and a warning that
    // re-derived that from `process.env` would drift from it.
    expect(source).toContain('if (sessions.usingDemoSecret) {');
    expect(source).toContain('system.log.warn(');
  });

  test('the warning names how it happened, what it costs, and what to do', () => {
    const warning = /system\.log\.warn\(\s*'([^']*)'/.exec(source)?.[1] ?? '';
    expect(warning, 'no single-quoted warning literal found in main.ts').not.toBe('');
    // The variable that allowed it — an operator who did not set it needs to
    // know which one to unset, and it is not the one the remedy names.
    expect(warning).toContain('CHAT_ALLOW_DEMO_SECRET');
    // Where the key is, so "demo secret" is not mistaken for "a weak secret".
    expect(warning).toContain('sessionStore.ts');
    // The consequence, in the terms an operator has to weigh.
    expect(warning).toContain('mint a token');
    // And the remedy.
    expect(warning).toContain('CHAT_TOKEN_SECRET');
  });
});
