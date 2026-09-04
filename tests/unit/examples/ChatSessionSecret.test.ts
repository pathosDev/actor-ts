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
});
