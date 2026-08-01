/**
 * Smoke case: HOCON config parsing cannot pollute the prototype (#406).
 *
 * Runtime-sensitive on purpose.  `__proto__` handling is engine behaviour, not
 * library behaviour — the setter lives on `Object.prototype`, and how a plain
 * assignment interacts with it is decided by the JS engine.  A unit test on
 * Bun alone would not prove Node and Deno refuse it too, so the guard is
 * verified on each runtime.
 *
 * The probe is a freshly built object rather than a captured one: pollution
 * shows up as an *inherited* property, so only a new `{}` reveals it.
 */
export const name = 'hocon prototype pollution';
export const description = 'a config source cannot reach Object.prototype';

export async function run({ actorTs }) {
  const { parseHocon, deepMerge } = actorTs;

  // 1. The severe vector: this used to parse to `{}` — looking harmless — while
  //    setting `Object.prototype.polluted` for the whole process.
  let refused = false;
  try {
    parseHocon('__proto__.polluted = true');
  } catch (e) {
    refused = /Refusing "__proto__"/.test(e.message);
    if (!refused) throw new Error(`wrong error for __proto__ key path: ${e.message}`);
  }
  if (!refused) throw new Error('a __proto__ key path was accepted');
  if ({}.polluted !== undefined) throw new Error('Object.prototype was polluted');

  // 2. The single-segment variant replaced the config object's own prototype.
  refused = false;
  try {
    parseHocon('"__proto__" { hacked = 1 }');
  } catch {
    refused = true;
  }
  if (!refused) throw new Error('a quoted __proto__ key was accepted');
  if ({}.hacked !== undefined) throw new Error('a quoted __proto__ key polluted the prototype');

  // 3. A substitution is a read, but it would still splice the prototype object
  //    into the resolved config.
  refused = false;
  try {
    parseHocon('x = ${__proto__}');
  } catch (e) {
    refused = /Refusing the substitution/.test(e.message);
  }
  if (!refused) throw new Error('a ${__proto__} substitution was accepted');

  // 4. `deepMerge` is exported and also merges plain JS objects, where
  //    JSON.parse yields an *own* __proto__ that Object.entries reports.
  const overlay = JSON.parse('{"__proto__":{"dmPwned":1}}');
  const merged = deepMerge({ a: 1 }, overlay);
  if (Object.getPrototypeOf(merged) !== Object.prototype) {
    throw new Error("deepMerge replaced the merged object's prototype");
  }
  if (merged.dmPwned !== undefined) throw new Error('deepMerge carried __proto__ through');
  if ({}.dmPwned !== undefined) throw new Error('deepMerge polluted Object.prototype');

  // 5. The guard is exact-match — it must not swallow legitimate keys.
  const ok = parseHocon('_proto_ = 1\nconstructorName = "x"\na.prototypes.b = 2');
  if (ok._proto_ !== 1) throw new Error('_proto_ was wrongly refused');
  if (ok.constructorName !== 'x') throw new Error('constructorName was wrongly refused');
  if (ok.a?.prototypes?.b !== 2) throw new Error('prototypes was wrongly refused');

  return 'refused __proto__ / constructor / prototype on keys, paths and substitutions';
}
