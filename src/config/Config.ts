import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigKeys } from './ConfigKeys.js';
import {
  DEFAULT_SECRETS_CONF_FILENAME,
  PROFILE_ENVIRONMENT_VARIABLE,
  PROFILES_ROOT_KEY,
  SECRETS_CONF_ENVIRONMENT_VARIABLE,
} from './Constants.js';
import { parseDuration } from './Duration.js';
import {
  type ConfigObject,
  type ConfigValue,
  deepMerge,
  isForbiddenConfigKey,
  isPlainObject,
  isSubstitution,
  parseHocon,
  resolveSubstitutions,
  stripUndefined,
} from './HoconParser.js';
import { REFERENCE_CONF } from './Reference.js';
import { parseSize } from './Size.js';

/** The carried secret paths of every config that carries none — shared, never written. */
const NO_SECRET_PATHS: ReadonlySet<string> = new Set();

/**
 * What every `Config` carries, whichever copy of actor-ts built it.
 *
 * Registered with `Symbol.for`, so two copies of the package in one process —
 * two in one dependency tree, or one file reached through two specifiers —
 * agree on it where they cannot agree on `instanceof`.  It is how
 * {@link Config.fromObject} tells another copy's instance from a tree: without
 * it that instance passed the plain-object test, and its own fields were read
 * as the configuration (found while #1425).
 */
const CONFIG_BRAND: unique symbol = Symbol.for('actor-ts.config');

/**
 * Immutable configuration tree loaded from HOCON files and/or code
 * overrides.  All accessors throw `ConfigError` on missing or
 * incorrectly-typed paths; `hasPath` lets callers probe beforehand.
 *
 *  Primary entry points:
 *  - `Config.load()` — merge reference.conf + application.conf + the secrets
 *    file, each with its active profile, + env.
 *  - `Config.parseString(s)` — parse an inline HOCON snippet.
 *  - `Config.parseFile(path)` — parse a file.  A raw parse: a `profiles`
 *    block is an ordinary key here, and only `load` reads it as profiles.
 *  - `Config.fromObject(obj)` — build from a plain JS object (code overrides).
 */
/**
 * Where each key in a loaded {@link Config} could have come from.
 *
 * Kept as whole layers rather than a per-key map: attribution is then a
 * lookup in each, in precedence order, and cannot disagree with the merge
 * — a precomputed map is a second answer to the same question.
 *
 * Six of them, lowest first: the bundled reference, the application file's
 * root and its active profile, the secrets file's root and its active
 * profile, and the code overrides (#1546).  The two layers of one file are
 * resolved in the same pass as the file itself — the profile laid over the
 * root first, the substitutions after — so each holds what the file actually
 * produced: a root alias reads what the profile gave its target, and a
 * profile key whose `${?VAR}` found nothing is not in the profile layer.
 */
export type ConfigLayers = {
  /** `reference.conf`, bundled with the package. */
  readonly reference: Config;
  /** The application file's root — all of it but `profiles` — or empty when there was none. */
  readonly application: Config;
  /** The application file's `profiles.<profile>` block, or empty when it has none or no profile is active. */
  readonly applicationProfile: Config;
  /** The secrets file's root, or empty when there was none. */
  readonly secrets: Config;
  /** The secrets file's `profiles.<profile>` block, or empty. */
  readonly secretsProfile: Config;
  /** Passed in code — `ActorSystemOptions.config`. */
  readonly overrides: Config;
  /**
   * Where the application file was looked for, whether or not one was there:
   * the path is what tells "my file is ignored" apart from "my file was never
   * where I thought it was".  `applicationFound` says which.
   */
  readonly applicationPath: string | null;
  /** True when a file existed at `applicationPath` and was read. */
  readonly applicationFound: boolean;
  /** Where the secrets file was looked for, whether or not one was there. */
  readonly secretsPath: string | null;
  /** True when a file existed at `secretsPath` and was read. */
  readonly secretsFound: boolean;
  /** The active profile, or `null` when none was selected. */
  readonly profile: string | null;
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

  /**
   * Leaf paths a secrets layer of another load set, carried with a tree that
   * left that load as plain data — see {@link _withSecretPaths}.  Empty for
   * every config not built by it.
   */
  private carriedSecretPaths: ReadonlySet<string> = NO_SECRET_PATHS;

  /** The brand — see {@link CONFIG_BRAND}.  On the prototype, so it is never an own key. */
  get [CONFIG_BRAND](): true { return true; }

  /* ------------------------------ Constructors ----------------------------- */

  static empty(): Config { return new Config({}); }

  static parseString(source: string): Config {
    const parsed = parseHocon(source);
    return new Config(stripUndefined(resolveSubstitutions(parsed)));
  }

  static parseFile(path: string): Config {
    return Config.parseString(readConfigFile(path));
  }

  /**
   * A config built from a plain object of overrides.
   *
   * This copy's own `Config` comes back as it is.  Anything else that is not a
   * plain object is refused, because the fallback used to be worse than an
   * error: a class instance passed the plain-object test, its own fields were
   * read as the tree, and the keys the caller meant went unread without a word
   * — an empty `Map` is an empty config.  A `Config` built by another copy of
   * actor-ts is the case that matters, and it gets its own message, since its
   * layers and the secret paths the boot dump withholds are private to the
   * copy that built it: reading only its tree could print a secrets-file value
   * in clear text.
   */
  static fromObject(obj: unknown): Config {
    if (obj === undefined || obj === null) return Config.empty();
    if (obj instanceof Config) return obj;
    if (isConfigOfAnotherCopy(obj)) {
      throw new ConfigError(
        'A Config built by another copy of actor-ts was passed in (ActorSystemOptions.withConfig, '
        + 'LoadOptions.overrides or Config.fromObject) — two copies of the package in one dependency tree, '
        + 'or one module reached through two specifiers.  Its layers and the secret paths it withholds belong '
        + 'to the copy that built it, so it cannot be read here.  Resolve a single copy of actor-ts, or build '
        + 'the Config with the copy that creates the system.',
      );
    }
    if (!isPlainObject(obj)) {
      throw new ConfigError(`Config.fromObject expects a plain object, got ${typeof obj}`);
    }
    if (!hasPlainPrototype(obj)) {
      throw new ConfigError(
        `Config.fromObject expects a plain object or a Config, got an instance of ${constructorNameOf(obj)}: `
        + 'the own fields of a class instance are not a configuration tree',
      );
    }
    return new Config(cloneTree(obj as ConfigObject));
  }

  /**
   * A config built from `tree`, as {@link fromObject} builds one, whose
   * leaves at `secretPaths` both renderers of the configuration withhold —
   * wherever it is merged as the overrides of a {@link load}.  The paths are
   * spelled the way those renderers print them (`secretLayerPaths` in
   * `src/diagnostics/ConfigDump.ts`): a key that is not a bare one, a key
   * holding a dot among them, in double quotes.
   *
   * @internal  How a WorkerMesh worker keeps its main thread's secrets-file
   * values out of its own boot dump (#1546).  The worker receives the main
   * thread's effective tree as one plain object, since a `Config` does not
   * survive `postMessage`, and its own `load` may not see the file the main
   * thread read: code can name that file in a way no environment variable
   * carries into the worker.  So the paths travel beside the tree.
   */
  static _withSecretPaths(tree: unknown, secretPaths: Iterable<string>): Config {
    const config = Config.fromObject(tree);
    config.carriedSecretPaths = new Set(secretPaths);
    return config;
  }

  /**
   * Load the standard config chain.  Precedence (highest first):
   *
   *   1. `overrides` passed in code.
   *   2. The secrets file's active profile — its `profiles.<profile>` block.
   *   3. The secrets file, resolved via `secretsConfPath` →
   *      `process.env.ACTOR_TS_SECRETS_CONF` → `./secrets.conf` in CWD.
   *   4. The application file's active profile.
   *   5. `application.conf` resolved via `appConfPath` → `process.env.ACTOR_TS_CONFIG`
   *      → `./application.conf` in CWD.
   *   6. `reference.conf` bundled with this package.
   *
   * The profile is `profile` → `process.env.ACTOR_TS_PROFILE` → none, and a
   * name neither file defines is refused rather than read as "no overlay".
   * Both files are optional: a path with no file behind it is an empty layer.
   *
   * Each file is resolved on its own, as before (#1071), with its active
   * profile laid over its root *before* its substitutions resolve — so an
   * alias in the root follows the profile, and an inactive profile is never
   * resolved at all.  Environment variables are consulted during that
   * resolution, not as a separate layer.
   */
  static load(options: LoadOptions = {}): Config {
    const environment = processEnvironment();
    const reference = Config.loadReference();
    const applicationPath = options.appConfPath
      ?? environment.ACTOR_TS_CONFIG
      ?? pathInWorkingDirectory('application.conf');
    const secretsPath = options.secretsConfPath
      ?? environment[SECRETS_CONF_ENVIRONMENT_VARIABLE]
      ?? pathInWorkingDirectory(DEFAULT_SECRETS_CONF_FILENAME);
    const profile = selectedProfile(options.profile, environment[PROFILE_ENVIRONMENT_VARIABLE]);
    const applicationFile = readProfiledFile(applicationPath);
    const secretsFile = readProfiledFile(secretsPath);
    if (profile !== null) {
      requireDefinedProfile(profile, [
        { description: 'application file', path: applicationPath, file: applicationFile },
        { description: 'secrets file', path: secretsPath, file: secretsFile },
      ]);
    }
    const application = resolveProfiledFile(applicationFile, applicationPath, profile?.name ?? null);
    const secrets = resolveProfiledFile(secretsFile, secretsPath, profile?.name ?? null);
    const overrides = Config.overridesLayer(options.overrides);
    // Build from reference up, with each layer overriding the last.  A file's
    // two layers arrive already merged — its profile over its root — because
    // they were resolved as one document.
    const merged = reference
      .merge(new Config(application.effective))
      .merge(new Config(secrets.effective))
      .merge(overrides);
    merged.layers = {
      reference,
      application: new Config(application.root),
      applicationProfile: new Config(application.profile),
      secrets: new Config(secrets.root),
      secretsProfile: new Config(secrets.profile),
      overrides,
      applicationPath: applicationPath ?? null,
      applicationFound: applicationFile !== null,
      secretsPath: secretsPath ?? null,
      secretsFound: secretsFile !== null,
      profile: profile?.name ?? null,
    };
    return merged;
  }

  /**
   * The code-supplied layer, refused when it carries a root `profiles` key.
   *
   * Refused rather than stripped: profiles are read from the two files `load`
   * reads itself, and a block passed in code would otherwise vanish with
   * nothing to say so — a silently ignored key is the failure the project
   * refuses everywhere else.  A loaded `Config` passed back in never trips
   * this, since `load` leaves no `profiles` key in what it returns.
   */
  private static overridesLayer(overrides: Config | unknown): Config {
    if (!overrides) return Config.empty();
    const layer = overrides instanceof Config ? overrides : Config.fromObject(overrides);
    if (Object.hasOwn(layer.tree, PROFILES_ROOT_KEY)) {
      throw new ConfigError(
        `A root "${PROFILES_ROOT_KEY}" key in the config passed in code (ActorSystemOptions.withConfig, `
        + 'LoadOptions.overrides) is refused: the key is reserved for the profile blocks of the application '
        + 'and secrets files, which Config.load lays over their own roots and strips.  Move the block into '
        + 'application.conf, or read the file with Config.load({ appConfPath, profile }) and pass that.',
      );
    }
    return layer;
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

  /**
   * {@link hasPath} for a path already cut into its keys.
   *
   * A quoted HOCON key may hold a dot — `my-app { "stripe.live" = … }` — and a
   * dotted path cannot name it, because every dot in one is a cut.  Asked as
   * `my-app.stripe.live`, a layer that holds that key says it does not.
   *
   * @internal  Read by `src/diagnostics/ConfigDump.ts`, which walks the
   * merged tree key by key and asks each layer about the same keys — the
   * question that decides which layer set a leaf and whether the secrets file
   * did (#1546).
   */
  _hasPathSegments(segments: readonly string[]): boolean {
    return this.lookupSegments(segments) !== undefined;
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

  /**
   * The paths {@link _withSecretPaths} attached, empty for every other config.
   *
   * @internal  Read by `src/diagnostics/ConfigDump.ts`, which decides what
   * the two renderers withhold.
   */
  _secretPaths(): ReadonlySet<string> { return this.carriedSecretPaths; }

  toJSON(): ConfigObject {
    return cloneTree(this.tree);
  }

  /* ------------------------------- Internal ------------------------------- */

  private lookup(path: string): ConfigValue | undefined {
    return this.lookupSegments(path.split('.'));
  }

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
  private lookupSegments(parts: readonly string[]): ConfigValue | undefined {
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
  /** The application file, ahead of `ACTOR_TS_CONFIG` and `./application.conf`. */
  readonly appConfPath?: string;
  /**
   * The secrets file, ahead of `ACTOR_TS_SECRETS_CONF` and `./secrets.conf`.
   * Optional as the application file is: a path with no file behind it is an
   * empty layer, so a deployment that keeps no secrets in a file needs
   * nothing (#1546).
   */
  readonly secretsConfPath?: string;
  /**
   * The active profile, ahead of `ACTOR_TS_PROFILE`.  A name neither file
   * defines under `profiles` is refused.  An empty string selects no profile
   * whatever the environment says, which is how code opts out of one the
   * environment selected.
   */
  readonly profile?: string;
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

/** A `Config` that `instanceof` does not recognise: one built by another copy of actor-ts. */
function isConfigOfAnotherCopy(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as { readonly [CONFIG_BRAND]?: unknown })[CONFIG_BRAND] === true;
}

/**
 * Whether `value` was made by an object literal, `JSON.parse` or
 * `Object.create(null)` rather than by a class.
 *
 * Asked of the prototype's prototype rather than compared against
 * `Object.prototype`, so a plain object from another realm — a `vm` context, a
 * worker that built its own — passes too: every realm's `Object.prototype`
 * ends the chain.  What fails is a class instance, whose own fields are not a
 * tree; that covers a `Config` from a copy of actor-ts too old to carry
 * {@link CONFIG_BRAND}.
 */
function hasPlainPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/** The class a refused instance was built by, for the message. */
function constructorNameOf(value: object): string {
  const name: unknown = (value as { readonly constructor?: { readonly name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name !== '' ? name : 'an anonymous class';
}

/**
 * The one read of a config file — `parseFile`'s, and each of the two files
 * `load` reads.
 *
 * Synchronous by contract, and ledgered as such in `NoSyncWorkInHandlers`:
 * the configuration is read at startup, before the system that would run on
 * it exists.  One function rather than a read per caller, so the secrets file
 * adds a file to that startup chain without adding a site to the ledger.
 */
function readConfigFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function pathInWorkingDirectory(fileName: string): string | undefined {
  try {
    return resolve(process.cwd(), fileName);
  } catch { return undefined; }
}

function processEnvironment(): Readonly<Record<string, string | undefined>> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/* -------------------------- Profiles and secrets ------------------------- */

/** The active profile, and what chose it — the refusal names the one to fix. */
type SelectedProfile = {
  readonly name: string;
  readonly selectedBy: string;
};

/**
 * The profile `load` lays over each file: the option, else the environment
 * variable, else none.  Empty means none at both levels — an exported but
 * empty variable is how a shell or a compose file spells "unset", and an
 * empty option is how code overrules the environment without naming another.
 */
function selectedProfile(option: string | undefined, variable: string | undefined): SelectedProfile | null {
  if (option !== undefined) {
    return option === '' ? null : { name: option, selectedBy: 'withProfile / LoadOptions.profile' };
  }
  if (variable === undefined || variable === '') return null;
  return { name: variable, selectedBy: PROFILE_ENVIRONMENT_VARIABLE };
}

/** One file `load` read, parsed and split, before any substitution is resolved. */
type ProfiledFile = {
  /** Everything but the `profiles` block, unresolved. */
  readonly root: ConfigObject;
  /**
   * Every profile the file defines, unresolved, by name — a verbatim copy
   * already followed to the block it copies.
   */
  readonly profiles: ReadonlyMap<string, ConfigObject>;
};

/**
 * Parse the file at `path` and split its `profiles` block off, or `null` when
 * there is no file — an empty layer, not an error, for both files.
 *
 * Every profile is checked to be a block here, the active one or not, so a
 * broken production profile fails the first run anywhere rather than the
 * first run in production.  None is resolved: substitutions belong to the
 * pass that knows which profile is active.
 */
function readProfiledFile(path: string | undefined): ProfiledFile | null {
  if (path === undefined || !existsSync(path)) return null;
  const parsed = parseHocon(readConfigFile(path));
  const root: ConfigObject = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== PROFILES_ROOT_KEY) root[key] = value;
  }
  const profiles = new Map<string, ConfigObject>();
  if (!Object.hasOwn(parsed, PROFILES_ROOT_KEY)) return { root, profiles };
  const block = parsed[PROFILES_ROOT_KEY];
  if (!isPlainObject(block)) {
    throw new ConfigError(
      `"${PROFILES_ROOT_KEY}" in ${path} is reserved for profile blocks — `
      + `${PROFILES_ROOT_KEY}.<name> { … } — and has to be a block of them, not ${describeValue(block)}`,
    );
  }
  for (const name of Object.keys(block)) profiles.set(name, profileBlock(parsed, block, name, path));
  return { root, profiles };
}

/**
 * `profiles.<name>` of a parsed file as the block of settings it is,
 * following a verbatim copy — `profiles.staging = ${profiles.production}` —
 * to the block it copies.
 *
 * Followed in the unresolved tree rather than resolved, so the copy carries
 * the original's own substitutions and they resolve against the overlay the
 * copy is laid over, exactly as the original's would.
 */
function profileBlock(parsed: ConfigObject, block: ConfigObject, name: string, path: string): ConfigObject {
  let value: ConfigValue | undefined = block[name];
  const followed: string[] = [];
  while (isSubstitution(value)) {
    if (followed.includes(value.path)) {
      throw new ConfigError(`${PROFILES_ROOT_KEY}.${name} in ${path} copies itself through \${${value.path}}`);
    }
    followed.push(value.path);
    const target: ConfigValue | undefined = unresolvedAt(parsed, value.path);
    value = target === undefined && value.optional ? value.previous : target;
  }
  if (isPlainObject(value)) return value;
  throw new ConfigError(
    followed.length === 0
      ? `${PROFILES_ROOT_KEY}.${name} in ${path} has to be a block of settings, not ${describeValue(value)}`
      : `${PROFILES_ROOT_KEY}.${name} in ${path} copies \${${followed[followed.length - 1]}}, which is not a `
        + 'block of settings in that file — a profile can copy another profile of its own file, and nothing else',
  );
}

/** The unresolved value at a dotted path, reading own keys of plain objects only. */
function unresolvedAt(tree: ConfigObject, path: string): ConfigValue | undefined {
  let node: ConfigValue | undefined = tree;
  for (const segment of path.split('.')) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return undefined;
    node = (node as ConfigObject)[segment];
  }
  return node;
}

/** One of the two files a profile may be defined in, for {@link requireDefinedProfile}. */
type ProfileSource = {
  readonly description: string;
  readonly path: string | undefined;
  readonly file: ProfiledFile | null;
};

/**
 * Refuse a profile neither file defines, naming the ones they do.
 *
 * Failing closed is the point: read as "no overlay", a misspelled
 * `ACTOR_TS_PROFILE=prodution` would start a production deployment on the
 * root's development values without a word.
 */
function requireDefinedProfile(profile: SelectedProfile, sources: ReadonlyArray<ProfileSource>): void {
  if (sources.some((source) => source.file?.profiles.has(profile.name) === true)) return;
  const defined = [...new Set(sources.flatMap((source) => [...(source.file?.profiles.keys() ?? [])]))].sort();
  const searched = sources
    .map((source) => `the ${source.description} (${source.path ?? 'none'}${source.file === null ? ', not found' : ''})`)
    .join(' or ');
  throw new ConfigError(
    `Config profile "${profile.name}" (selected by ${profile.selectedBy}) is not defined: there is no `
    + `${PROFILES_ROOT_KEY}.${profile.name} block in ${searched}.  Defined profiles: `
    + `${defined.length === 0 ? 'none' : defined.join(', ')}.`,
  );
}

/** One file's contribution to the merge, and its two layers. */
type ResolvedProfiledFile = {
  /** The root with the active profile laid over it, resolved — what the file contributes. */
  readonly effective: ConfigObject;
  /** The root's own keys, resolved in the same pass. */
  readonly root: ConfigObject;
  /** The active profile's own keys, resolved in the same pass. */
  readonly profile: ConfigObject;
};

/**
 * Lay the active profile over the file's root, then resolve — the root and
 * the profile in that same pass.
 *
 * Overlay first, so an alias in the root follows the profile:
 * `primary-host = ${my-app.host}` reads the production host when production
 * sets one.  Still per file (#1071), so a substitution reaches its own file
 * and the environment, never another layer.
 *
 * The two parts are resolved inside the same tree because a substitution
 * path is absolute: resolved on its own, a root alias would read the root's
 * value of its target, not the one the file produced.  They sit under the
 * reserved `profiles` key, which the overlay no longer has and which no
 * substitution may read (refused below), so the scratch cannot collide with
 * a key of the file or be spliced into one of its values.
 */
function resolveProfiledFile(
  file: ProfiledFile | null,
  path: string | undefined,
  profile: string | null,
): ResolvedProfiledFile {
  if (file === null) return { effective: {}, root: {}, profile: {} };
  const overlay = profile === null ? {} : (file.profiles.get(profile) ?? {});
  refuseProfilesReference(file.root, path);
  refuseProfilesReference(overlay, path);
  const scratch: ConfigObject = {
    ...deepMerge(file.root, overlay),
    [PROFILES_ROOT_KEY]: { root: file.root, profile: overlay },
  };
  const resolved = resolveSubstitutions(scratch);
  const parts = resolved[PROFILES_ROOT_KEY] as ConfigObject;
  const effective: ConfigObject = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (key !== PROFILES_ROOT_KEY) effective[key] = value;
  }
  return {
    effective: stripUndefined(effective),
    root: stripUndefined(parts['root'] as ConfigObject),
    profile: stripUndefined(parts['profile'] as ConfigObject),
  };
}

/**
 * Refuse a substitution that reads the `profiles` block.
 *
 * The block is gone before the file resolves, so such a reference could only
 * ever fail as an unresolved one — or, as the bare `${profiles}`, read the
 * scratch `resolveProfiledFile` resolves in.  Said here by name instead.  A
 * whole-profile copy is not a reference of this kind: it is followed when the
 * file is read, before anything resolves.
 */
function refuseProfilesReference(tree: ConfigObject, path: string | undefined): void {
  const reference = profilesReferenceIn(tree);
  if (reference === null) return;
  throw new ConfigError(
    `\${${reference}} in ${path ?? 'a config file'} reads the ${PROFILES_ROOT_KEY} block, which Config.load `
    + 'strips before it resolves the file.  A substitution may read the root of its own file — with the '
    + `active profile laid over it — and the environment; a whole profile can be copied with `
    + `${PROFILES_ROOT_KEY}.<name> = \${${PROFILES_ROOT_KEY}.<other>}.`,
  );
}

/** The path of the first substitution in `value` that reads the `profiles` block, or `null`. */
function profilesReferenceIn(value: ConfigValue | undefined): string | null {
  if (isSubstitution(value)) {
    if (value.path === PROFILES_ROOT_KEY || value.path.startsWith(`${PROFILES_ROOT_KEY}.`)) return value.path;
    return profilesReferenceIn(value.previous);
  }
  const children = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  for (const child of children) {
    const reference = profilesReferenceIn(child);
    if (reference !== null) return reference;
  }
  return null;
}

/** A value's kind, for a refusal that has to say what it found instead. */
function describeValue(value: ConfigValue | undefined): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (isSubstitution(value)) return `\${${value.path}}`;
  return `a ${typeof value}`;
}

/** Re-exports for callers that want to build Configs without using the class. */
export { deepMerge, isPlainObject, parseHocon, resolveSubstitutions };
export type { ConfigObject, ConfigValue } from './HoconParser.js';
