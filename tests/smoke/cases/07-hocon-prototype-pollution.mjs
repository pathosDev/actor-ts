/**
 * Smoke case: HOCON config parsing cannot pollute the prototype (#406) and
 * cannot read through it either (#589).
 *
 * Runtime-sensitive on purpose.  `__proto__` handling is engine behaviour, not
 * library behaviour — the setter lives on `Object.prototype`, and how a plain
 * assignment interacts with it is decided by the JS engine.  A unit test on
 * Bun alone would not prove Node and Deno refuse it too, so the guard is
 * verified on each runtime.
 *
 * The read side (#589) divides the runtimes even more sharply: `process.env` is
 * a proxy, and `process.env.toString` is a native function on Node and Deno but
 * `undefined` on Bun — so the unguarded environment read this case now covers
 * was invisible on the primary toolchain and live on the other two.
 *
 * The probe is a freshly built object rather than a captured one: pollution
 * shows up as an *inherited* property, so only a new `{}` reveals it.
 */
export const name = 'hocon prototype pollution';
export const description = 'a config source can neither reach nor read Object.prototype';

export async function run({ actorTs }) {
  const { parseHocon, deepMerge, resolveSubstitutions, Config } = actorTs;

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

  // 6. (#589) The read side: `${toString}` is not one of the three refused
  //    names, so it reached the descent — which used to answer it out of
  //    Object.prototype and splice a native function into the config.
  let unresolved = false;
  try {
    resolveSubstitutions(parseHocon('x = ${toString}'));
  } catch (e) {
    unresolved = /Unresolved substitution/.test(e.message);
    if (!unresolved) throw new Error(`wrong error for \${toString}: ${e.message}`);
  }
  if (!unresolved) throw new Error('${toString} resolved to an inherited member');

  // 7. (#589) The environment read is prototype-backed too, and this is the
  //    part that differs per runtime: on Node and Deno `env.toString` is a
  //    native function, on Bun it is undefined.  An empty map must behave the
  //    same everywhere — the optional substitution simply misses.
  const optional = resolveSubstitutions(parseHocon('x = ${?valueOf}'), {});
  if (typeof optional.x === 'function') throw new Error('an env read spliced a native function');
  if (optional.x !== undefined) throw new Error(`\${?valueOf} resolved to ${String(optional.x)}`);

  // 8. (#589) …and a real env entry still resolves, on every runtime — the
  //    guard must not cost the feature it protects.
  const supplied = resolveSubstitutions(parseHocon('x = ${?SMOKE_ENV_VALUE}'), { SMOKE_ENV_VALUE: 'yes' });
  if (supplied.x !== 'yes') throw new Error(`env substitution broke: ${String(supplied.x)}`);

  // 9. (#589) The public accessors take the same path.  `hasPath` answering
  //    true here is what made `getString` throw a type error on a function.
  const config = Config.parseString('a = 1');
  for (const member of ['toString', 'valueOf', 'hasOwnProperty', 'constructor', '__proto__']) {
    if (config.hasPath(member)) throw new Error(`hasPath("${member}") is true`);
  }
  if (Config.fromObject(JSON.parse('{"__proto__":{"clonePwned":1},"a":1}')).hasPath('clonePwned')) {
    throw new Error('fromObject cloned an own __proto__ through');
  }
  if ({}.clonePwned !== undefined) throw new Error('fromObject polluted Object.prototype');

  return 'refused __proto__ / constructor / prototype as keys, and every inherited member as a read';
}
