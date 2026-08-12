/**
 * Smoke case: the public util helpers (#1034).
 *
 * `randomString` is the runtime-sensitive one — it reads entropy from
 * `globalThis.crypto.getRandomValues`, which is a Web API that Bun, Node
 * and Deno each provide from a different place.  A unit test on Bun
 * proves nothing about the other two, and the failure mode is not a type
 * error: it is generated actor names going undefined-shaped at runtime,
 * on whichever runtime the user picked.  `randomUuid` (#1109) is here for
 * exactly that reason and one more: it delegates to
 * `globalThis.crypto.randomUUID`, a *second* Web API off the same object,
 * and a runtime can carry one without the other.
 *
 * `safeStringify` and `lazyImportModule` ride along because they are the
 * other two names this issue put in the surface and they cost one call
 * each.  `lazyImportModule`'s rejection path is the interesting one —
 * the three runtimes word their own module-resolution failure
 * differently, and the helper's contract is that the message still names
 * the package and how to install it.
 *
 * The `exists` predicate (#1141) rides along for a weaker reason, stated
 * plainly: the retry loop is ordinary JavaScript and cannot differ per
 * runtime.  What it buys is that this file is the only place the four
 * helpers' *public call shapes* meet the built `dist/`, so the overloads
 * and the trailing parameter are exercised against what actually ships.
 * A thousand extra draws cost under a millisecond.
 */
export const name = 'public util helpers';
export const description = 'randomString entropy + safeStringify cycle + lazyImportModule error';

export async function run({ actorTs }) {
  const { randomString, randomHex, randomId, randomUuid, safeStringify, lazyImportModule } = actorTs;

  for (const [label, value, pattern] of [
    ['randomHex', randomHex(16), /^[0-9a-f]{16}$/],
    ['randomId', randomId(12), /^[0-9a-f]{12}$/],
    ['randomString', randomString(24), /^[A-Za-z0-9]{24}$/],
    ['randomString(lowercase)', randomString(24, { upperCase: false, digits: false }), /^[a-z]{24}$/],
    ['randomUuid', randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
  ]) {
    if (!pattern.test(value)) throw new Error(`${label}: ${JSON.stringify(value)} !~ ${pattern}`);
  }
  if (randomHex(32) === randomHex(32)) throw new Error('randomHex returned the same value twice');
  if (randomUuid() === randomUuid()) throw new Error('randomUuid returned the same value twice');

  // Nine of the ten digits are taken, so '9' is the only value the predicate
  // lets through — the redraw is what has to find it.
  const taken = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
  const free = randomString(1, { lowerCase: false, upperCase: false }, (c) => taken.has(c));
  if (free !== '9') throw new Error(`randomString did not redraw to the one free digit: ${free}`);

  let attempts = 0;
  let exhausted = null;
  try {
    randomUuid(() => { attempts++; return true; });
  } catch (e) {
    exhausted = e.message;
  }
  if (exhausted === null) throw new Error('randomUuid with an always-taken predicate returned');
  if (attempts !== 1000) throw new Error(`randomUuid drew ${attempts} candidates, expected 1000`);
  if (!exhausted.includes('randomUuid')) {
    throw new Error(`exhaustion message does not name the helper: ${exhausted}`);
  }

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const rendered = safeStringify(cyclic);
  if (!rendered.includes('[Circular]')) {
    throw new Error(`safeStringify did not mark the cycle: ${rendered}`);
  }

  const missing = 'actor-ts-no-such-peer-dependency';
  let message = null;
  try {
    await lazyImportModule(missing, { context: 'SmokeCase' });
  } catch (e) {
    message = e.message;
  }
  if (message === null) throw new Error(`lazyImportModule('${missing}') resolved`);
  for (const expected of [`SmokeCase requires the '${missing}' package`, `npm install ${missing}`]) {
    if (!message.includes(expected)) {
      throw new Error(`lazyImportModule message missing ${JSON.stringify(expected)}: ${message}`);
    }
  }

  const nodePath = await lazyImportModule('node:path');
  if (typeof nodePath.join !== 'function') throw new Error('lazyImportModule lost the module shape');
}
