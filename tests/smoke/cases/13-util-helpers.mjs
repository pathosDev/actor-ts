/**
 * Smoke case: the public util helpers (#1034).
 *
 * `randomString` is the runtime-sensitive one — it reads entropy from
 * `globalThis.crypto.getRandomValues`, which is a Web API that Bun, Node
 * and Deno each provide from a different place.  A unit test on Bun
 * proves nothing about the other two, and the failure mode is not a type
 * error: it is generated actor names going undefined-shaped at runtime,
 * on whichever runtime the user picked.
 *
 * `safeStringify` and `lazyImportModule` ride along because they are the
 * other two names this issue put in the surface and they cost one call
 * each.  `lazyImportModule`'s rejection path is the interesting one —
 * the three runtimes word their own module-resolution failure
 * differently, and the helper's contract is that the message still names
 * the package and how to install it.
 */
export const name = 'public util helpers';
export const description = 'randomString entropy + safeStringify cycle + lazyImportModule error';

export async function run({ actorTs }) {
  const { randomString, randomHex, randomId, safeStringify, lazyImportModule } = actorTs;

  for (const [label, value, pattern] of [
    ['randomHex', randomHex(16), /^[0-9a-f]{16}$/],
    ['randomId', randomId(12), /^[0-9a-f]{12}$/],
    ['randomString', randomString(24), /^[A-Za-z0-9]{24}$/],
    ['randomString(lowercase)', randomString(24, { upperCase: false, digits: false }), /^[a-z]{24}$/],
  ]) {
    if (!pattern.test(value)) throw new Error(`${label}: ${JSON.stringify(value)} !~ ${pattern}`);
  }
  if (randomHex(32) === randomHex(32)) throw new Error('randomHex returned the same value twice');

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
