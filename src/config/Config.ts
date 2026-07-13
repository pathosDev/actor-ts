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
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
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
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseDuration(value);
    throw typeError(path, 'duration', value);
  }

  /** Byte count. */
  getBytes(path: string): number {
    const value = this.requireValue(path);
    if (typeof value === 'number') return value;
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
  toJSON(): ConfigObject {
    return cloneTree(this.tree);
  }

  /* ------------------------------- Internal ------------------------------- */

  private lookup(path: string): ConfigValue | undefined {
    const parts = path.split('.');
    let cur: ConfigValue | undefined = this.tree;
    for (const part of parts) {
      if (!isPlainObject(cur)) return undefined;
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
  for (const [key, value] of Object.entries(obj)) {
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
