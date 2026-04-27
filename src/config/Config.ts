import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseDuration } from './Duration.js';
import {
  type ConfigObject,
  type ConfigValue,
  deepMerge,
  isPlainObject,
  parseHocon,
  resolveSubstitutions,
  stripUndefined,
} from './HoconParser.js';
import { REFERENCE_CONF } from './reference.js';
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
export class Config {
  private constructor(private readonly tree: ConfigObject) {}

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
    return reference.merge(application).merge(overrides);
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
    const v = this.requireValue(path);
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw typeError(path, 'string', v);
  }

  getInt(path: string): number {
    const n = this.getNumber(path);
    if (!Number.isInteger(n)) throw typeError(path, 'integer', n);
    return n;
  }

  getNumber(path: string): number {
    const v = this.requireValue(path);
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    throw typeError(path, 'number', v);
  }

  getBoolean(path: string): boolean {
    const v = this.requireValue(path);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (s === 'true' || s === 'yes' || s === 'on') return true;
      if (s === 'false' || s === 'no' || s === 'off') return false;
    }
    throw typeError(path, 'boolean', v);
  }

  /** Duration in milliseconds. */
  getDuration(path: string): number {
    const v = this.requireValue(path);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseDuration(v);
    throw typeError(path, 'duration', v);
  }

  /** Byte count. */
  getBytes(path: string): number {
    const v = this.requireValue(path);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseSize(v);
    throw typeError(path, 'size', v);
  }

  getStringList(path: string): string[] {
    const v = this.requireValue(path);
    if (!Array.isArray(v)) throw typeError(path, 'list', v);
    return v.map((x, i) => {
      if (typeof x === 'string') return x;
      if (typeof x === 'number' || typeof x === 'boolean') return String(x);
      throw new ConfigError(`${path}[${i}] is not a string (got ${typeof x})`);
    });
  }

  getList(path: string): ConfigValue[] {
    const v = this.requireValue(path);
    if (!Array.isArray(v)) throw typeError(path, 'list', v);
    return v as ConfigValue[];
  }

  getObject(path: string): ConfigObject {
    const v = this.requireValue(path);
    if (!isPlainObject(v)) throw typeError(path, 'object', v);
    return v as ConfigObject;
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
      const k = parts[i]!;
      cur = { [k]: cur };
    }
    return new Config(cur);
  }

  /** Deep-clone the underlying tree as a plain object. */
  toJSON(): ConfigObject {
    return cloneTree(this.tree);
  }

  /* ------------------------------- Internal ------------------------------- */

  private lookup(path: string): ConfigValue | undefined {
    const parts = path.split('.');
    let cur: ConfigValue | undefined = this.tree;
    for (const p of parts) {
      if (!isPlainObject(cur)) return undefined;
      cur = (cur as ConfigObject)[p];
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  private requireValue(path: string): ConfigValue {
    const v = this.lookup(path);
    if (v === undefined) throw new ConfigError(`Missing config value at path "${path}"`);
    return v;
  }
}

export interface LoadOptions {
  readonly appConfPath?: string;
  readonly overrides?: Config | unknown;
}

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

function cloneTree(obj: ConfigObject): ConfigObject {
  const out: ConfigObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      out[k] = v.map(x => (isPlainObject(x) ? cloneTree(x as ConfigObject) : x)) as ConfigValue[];
    } else if (isPlainObject(v)) {
      out[k] = cloneTree(v as ConfigObject);
    } else {
      out[k] = v;
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
