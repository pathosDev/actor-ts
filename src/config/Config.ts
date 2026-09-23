import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigKeys } from './ConfigKeys.js';
import { parseDuration } from './Duration.js';
import {
  type ConfigObject,
  type ConfigValue,
  deepMerge,
  isForbiddenConfigKey,
  isPlainObject,
  parseHocon,
  resolveSubstitutions,
  stripUndefined,
} from './HoconParser.js';
import { REFERENCE_CONF } from './Reference.js';
import { parseSize } from './Size.js';

/**
 * Immutable configuration tree loaded from HOCON files and/or code
 * overrides.  All accessors throw `ConfigError` on missing or
 * incorrectly-typed paths; `hasPath` lets callers probe beforehand.
 *
 *  Primary entry points:
 *  - `Config.load()` — merge reference.conf + application.conf + env.
 *  - `Config.parseString(s)` — parse an inline HOCON snippet.
 *  - `Config.parseFile(path)` — parse a file.
 *  - `Config.fromObject(obj)` — build from a plain JS object (code overrides).
 */
/**
 * Where each key in a loaded {@link Config} could have come from.
 *
 * Kept as whole layers rather than a per-key map: attribution is then a
 * lookup in each, in precedence order, and cannot disagree with the merge
 * — a precomputed map is a second answer to the same question.
 */
export type ConfigLayers = {
  /** `reference.conf`, bundled with the package. */
  readonly reference: Config;
  /** `application.conf`, or an empty config when there was none. */
  readonly application: Config;
  /** Where `application.conf` was read from, when it was read. */
  readonly applicationPath: string | null;
  /** Passed in code — `ActorSystemOptions.config`. */
  readonly overrides: Config;
};

export class Config {
  private constructor(private readonly tree: ConfigObject) {}

  /**
   * The layers {@link load} merged, kept for attribution (#553).
   *
   * Only the object `load` returns carries them — a `merge` or `atPath`
   * derived from it does not, because the layers would no longer describe
   * the tree.  `null` everywhere else, which is the honest answer: a
   * config built by `parseString` has one source and no precedence to
   * explain.
   */
  private layers: ConfigLayers | null = null;

  /* ------------------------------ Constructors ----------------------------- */

  static empty(): Config { return new Config({}); }

  static parseString(source: string): Config {
    const parsed = parseHocon(source);
    return new Config(stripUndefined(resolveSubstitutions(parsed)));
  }

  static parseFile(path: string): Config {
    const source = readFileSync(path, 'utf8');
    return Config.parseString(source);
  }

  static fromObject(obj: unknown): Config {
    if (obj === undefined || obj === null) return Config.empty();
    if (!isPlainObject(obj)) {
      throw new ConfigError(`Config.fromObject expects a plain object, got ${typeof obj}`);
    }
    return new Config(cloneTree(obj as ConfigObject));
  }

  /**
   * Load the standard config chain.  Precedence (highest first):
   *
   *   1. `overrides` passed in code.
   *   2. `application.conf` resolved via `appConfPath` → `process.env.ACTOR_TS_CONFIG`
   *      → `./application.conf` in CWD.
   *   3. `reference.conf` bundled with this package.
   *
   * Environment variables are consulted during substitution resolution
   * (inside each parse step), not as a separate layer.
   */
  static load(options: LoadOptions = {}): Config {
    const reference = Config.loadReference();
    const applicationPath = options.appConfPath
      ?? (typeof process !== 'undefined' ? process.env.ACTOR_TS_CONFIG : undefined)
      ?? defaultApplicationConfPath();
    const application = applicationPath && existsSync(applicationPath)
      ? Config.parseFile(applicationPath)
      : Config.empty();
    const overrides = options.overrides
      ? (options.overrides instanceof Config ? options.overrides : Config.fromObject(options.overrides))
      : Config.empty();
    // Build from reference up, with each layer overriding the last.
    const merged = reference.merge(application).merge(overrides);
    merged.layers = {
      reference,
      application,
      applicationPath: applicationPath ?? null,
      overrides,
    };
    return merged;
  }

  /** Load the bundled reference defaults.  Cached for the process. */
  private static _referenceCache: Config | null = null;
  static loadReference(): Config {
    if (Config._referenceCache) return Config._referenceCache;
    Config._referenceCache = Config.parseString(REFERENCE_CONF);
    return Config._referenceCache;
  }

  /* --------------------------------- Access -------------------------------- */

  hasPath(path: string): boolean {
    return this.lookup(path) !== undefined;
  }

  getString(path: string): string {
    const value = this.requireValue(path);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw typeError(path, 'string', value);
  }

  getInt(path: string): number {
    const numberValue = this.getNumber(path);
    if (!Number.isInteger(numberValue)) throw typeError(path, 'integer', numberValue);
    return numberValue;
  }

  getNumber(path: string): number {
    const value = this.requireValue(path);
    if (typeof value === 'number') return requireFinite(path, 'number', value);
    // The string branch is not merely symmetry here.  `HoconParser` keeps a
    // numeric literal as a *string* exactly when it is not finite, so a literal
    // long enough to overflow a double arrives as one — and the regex below
    // matches it, which is how `Number(...)` hands back the `Infinity` the
    // parser declined to build.  `getDuration` and `getBytes` are covered on
    // this branch already, by the parsers they delegate to.
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      return requireFinite(path, 'number', Number(value));
    }
    throw typeError(path, 'number', value);
  }

  getBoolean(path: string): boolean {
    const value = this.requireValue(path);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
      if (normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
    }
    throw typeError(path, 'boolean', value);
  }

  /** Duration in milliseconds. */
  getDuration(path: string): number {
    const value = this.requireValue(path);
    if (typeof value === 'number') return requireFinite(path, 'duration', value);
    if (typeof value === 'string') return parseDuration(value);
    throw typeError(path, 'duration', value);
  }

  /** Byte count. */
  getBytes(path: string): number {
    const value = this.requireValue(path);
    if (typeof value === 'number') return requireFinite(path, 'size', value);
    if (typeof value === 'string') return parseSize(value);
    throw typeError(path, 'size', value);
  }

  getStringList(path: string): string[] {
    const value = this.requireValue(path);
    if (!Array.isArray(value)) throw typeError(path, 'list', value);
    return value.map((x, i) => {
      if (typeof x === 'string') return x;
      if (typeof x === 'number' || typeof x === 'boolean') return String(x);
      throw new ConfigError(`${path}[${i}] is not a string (got ${typeof x})`);
    });
  }

  getList(path: string): ConfigValue[] {
    const value = this.requireValue(path);
    if (!Array.isArray(value)) throw typeError(path, 'list', value);
    return value as ConfigValue[];
  }

  getObject(path: string): ConfigObject {
    const value = this.requireValue(path);
    if (!isPlainObject(value)) throw typeError(path, 'object', value);
    return value as ConfigObject;
  }

  getConfig(path: string): Config {
    return new Config(this.getObject(path));
  }

  /* ------------------------------- Layering ------------------------------- */

  /**
   * Merge `other` underneath this config — i.e. values defined here win,
   * keys that only exist in `other` are filled in.
   */
  withFallback(other: Config): Config {
    return new Config(deepMerge(other.tree, this.tree));
  }

  /** Inverse of withFallback — layer `overlay` on top. */
  merge(overlay: Config): Config {
    return new Config(deepMerge(this.tree, overlay.tree));
  }

  /** Wrap the tree under the given path: `{a:{b:1}}`.atPath("x.y") → `{x:{y:{a:{b:1}}}}`. */
  atPath(path: string): Config {
    const parts = path.split('.').filter(Boolean);
    let cur: ConfigObject = this.tree;
    for (let i = parts.length - 1; i >= 0; i--) {
      const key = parts[i]!;
      cur = { [key]: cur };
    }
    return new Config(cur);
  }

  /** Deep-clone the underlying tree as a plain object. */
  /**
   * The layers this config was merged from, or `null`.
   *
   * @internal  DevTools' resolved-config panel (#553) — it is what lets
   * a key say which file it came from rather than only what it is now.
   */
  _sources(): ConfigLayers | null { return this.layers; }

  toJSON(): ConfigObject {
    return cloneTree(this.tree);
  }

  /* ------------------------------- Internal ------------------------------- */

  /**
   * Descends **own** properties only, so no path can reach `Object.prototype`.
   *
   * Without the `Object.hasOwn` guard every inherited member answers a lookup:
   * `hasPath('toString')` came back `true` and `getString('toString')` then
   * threw a type error on a native function, which reads as a config bug rather
   * than the bad path it is.  A blocklist of prototype member names cannot do
   * this job — the chain is open-ended — so the guard is positive.
   *
   * No forbidden-key check is needed alongside it: every builder of a tree
   * (`cloneTree`, `deepMerge`, `stripUndefined`) drops those keys, so an *own*
   * `__proto__` — the one case `Object.hasOwn` would wave through — cannot be
   * in `this.tree` to begin with.
   */
  private lookup(path: string): ConfigValue | undefined {
    const parts = path.split('.');
    let cur: ConfigValue | undefined = this.tree;
    for (const part of parts) {
      if (!isPlainObject(cur)) return undefined;
      if (!Object.hasOwn(cur, part)) return undefined;
      cur = (cur as ConfigObject)[part];
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  private requireValue(path: string): ConfigValue {
    const value = this.lookup(path);
    if (value === undefined) throw new ConfigError(`Missing config value at path "${path}"`);
    return value;
  }
}

export type LoadOptions = {
  readonly appConfPath?: string;
  readonly overrides?: Config | unknown;
};

/** Thrown on type mismatches or missing paths. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function typeError(path: string, expected: string, actual: unknown): ConfigError {
  const actualType = actual === null ? 'null' : Array.isArray(actual) ? 'list' : typeof actual;
  return new ConfigError(`Config at "${path}" is not a ${expected} (got ${actualType})`);
}

/** How the three numeric accessors name themselves in an error message. */
type NumericAccessorKind = 'number' | 'duration' | 'size';

/**
 * The two keys where `+Infinity` is the documented value, mapped to the
 * accessor each is actually read with.
 *
 * `reference.conf` says of both that `Infinity` switches the bound off and
 * that it is *code only*, because HOCON has no `Infinity` literal.  The first
 * shape of {@link requireFinite} read "code only" as "through the options
 * builder", which is wrong by a whole path: `WebsocketPolicy` reads
 * `accept-timeout` with `getDuration` and `ObjectStoragePluginOptions` reads
 * `max-decompressed-bytes` with `getBytes`, so an overrides object — the other
 * thing "code" means, and what `ActorSystemOptions.withConfig` builds — went
 * through this check and was refused.  That narrowed a documented contract
 * three other layers still state: `ConnectionWiring` arms the accept watchdog
 * behind `Number.isFinite`, and both validators admit `Infinity` by name.
 *
 * Keyed on the path *and* the accessor rather than on either alone, because
 * neither key has an unbounded spelling in any other reading: `accept-timeout`
 * read as a plain number, or a sibling leaf in the same block, is a value
 * nothing downstream is built to survive.  `NaN` and `-Infinity` spell nothing
 * anywhere and stay refused here as everywhere else.
 *
 * Lives beside the check rather than in a `Constants.ts`: it is not a tuned
 * bound but the lookup table this function *is*, and the paths come from
 * `ConfigKeys` so a renamed leaf moves it too.
 */
const UNBOUNDED_OPT_OUT_PATHS: ReadonlyMap<string, NumericAccessorKind> = new Map([
  [ConfigKeys.http.websocket.acceptTimeout, 'duration'],
  [ConfigKeys.persistence.snapshotStore.objectStorage.maxDecompressedBytes, 'size'],
]);

/**
 * Refuse a number no consumer downstream can compute with.
 *
 * `NaN` and `±Infinity` are `'number'` to `typeof`, so the three numeric
 * accessors used to short-circuit on them and hand them straight back.  #785
 * gave `parseDuration` and `parseSize` a finite postcondition, but a value that
 * arrives as a *number* never reaches either parser — the accessor returns
 * before the delegation — so that postcondition covered only half the path.
 *
 * Reported through {@link ConfigError} rather than by the parsers' own message
 * because this one can name the **path**, and that is the whole difference the
 * check makes.  A non-finite value gets in via a code-supplied overrides object
 * (`ActorSystemOptions.withConfig`, `Config.fromObject`) — the canonical origin
 * being `Number(process.env.SOME_MS)` with the variable unset, which is a
 * `NaN` produced nowhere near the key it lands on.  It then fails open rather
 * than loudly: `actor-ts.system.shutdown-drain-timeout` has no options
 * validator between the read and `setTimeout`, and a `NaN` there defeats the
 * documented `<= 0` opt-out *and* makes `deadline = Date.now() + NaN`, so the
 * drain budget is silently zero.  A cap read with `getBytes` goes the other
 * way: every comparison against `NaN` is false, so the cap stops capping.
 *
 * The two `Infinity` opt-outs `reference.conf` documents are the one exception,
 * and they are exceptions precisely because they *do* arrive here — see
 * {@link UNBOUNDED_OPT_OUT_PATHS}.
 */
function requireFinite(path: string, expected: NumericAccessorKind, value: number): number {
  if (value === Number.POSITIVE_INFINITY && UNBOUNDED_OPT_OUT_PATHS.get(path) === expected) {
    return value;
  }
  if (!Number.isFinite(value)) {
    throw new ConfigError(`Config at "${path}" is not a finite ${expected} (got ${value})`);
  }
  return value;
}

/**
 * Deep-copy a tree, dropping forbidden keys exactly as `deepMerge` and
 * `stripUndefined` do.  The filter is not decoration: this runs on
 * caller-supplied objects (`Config.fromObject`, and through it
 * `ActorSystemOptions.withConfig` and `Config.load({ overrides })`), where
 * `JSON.parse('{"__proto__":{…}}')` yields an *own* `__proto__` that
 * `Object.entries` reports and the plain `out[key] = …` below would hand to the
 * inherited setter — re-parenting the fresh tree.
 */
function cloneTree(obj: ConfigObject): ConfigObject {
  const out: ConfigObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isForbiddenConfigKey(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.map(x => (isPlainObject(x) ? cloneTree(x as ConfigObject) : x)) as ConfigValue[];
    } else if (isPlainObject(value)) {
      out[key] = cloneTree(value as ConfigObject);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function defaultApplicationConfPath(): string | undefined {
  try {
    return resolve(process.cwd(), 'application.conf');
  } catch { return undefined; }
}

/** Re-exports for callers that want to build Configs without using the class. */
export { deepMerge, isPlainObject, parseHocon, resolveSubstitutions };
export type { ConfigObject, ConfigValue } from './HoconParser.js';
