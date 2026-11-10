import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { MemcachedClientLike } from './MemcachedCache.js';

/**
 * Built-in default server list, published as
 * `actor-ts.cache.memcached.servers`.  A **comma-separated string**, not a
 * list: that is the shape `memjs`'s `Client.create` takes, and the field it
 * lands in is `readonly servers?: string`.
 */
export const DEFAULT_MEMCACHED_SERVERS = 'localhost:11211';

/** Plain options-object shape accepted by a {@link MemcachedCache}. */
export type MemcachedCacheOptionsType = {
  /** Comma-separated server list, e.g. `'localhost:11211'`.  Default: `'localhost:11211'`. */
  readonly servers?: string;
  /** Optional username/password for SASL auth. */
  readonly username?: string;
  readonly password?: string;
  /** Optional key prefix (server-side, applied to every operation). */
  readonly keyPrefix?: string;
  /** Pre-built memjs client — bypass internal construction. */
  readonly client?: MemcachedClientLike;
};

/**
 * Fluent builder for {@link MemcachedCacheOptionsType}:
 *
 *     new MemcachedCache(MemcachedCacheOptions.create().withServers('localhost:11211').withKeyPrefix('app:'))
 */
export class MemcachedCacheOptionsBuilder extends OptionsBuilder<MemcachedCacheOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MemcachedCacheOptionsBuilder()`. */
  static create(): MemcachedCacheOptionsBuilder {
    return new MemcachedCacheOptionsBuilder();
  }

  /** Comma-separated server list, e.g. `'localhost:11211'`.  Default: `'localhost:11211'`. */
  withServers(servers: string): this {
    return this.set('servers', servers);
  }

  /** Username / password for SASL auth. */
  withCredentials(username: string, password: string): this {
    this.set('username', username);
    return this.set('password', password);
  }

  /** Key prefix applied server-side to every operation. */
  withKeyPrefix(prefix: string): this {
    return this.set('keyPrefix', prefix);
  }

  /** Pre-built memjs client — bypass internal construction. */
  withClient(client: MemcachedClientLike): this {
    return this.set('client', client);
  }
}

/** Validates resolved {@link MemcachedCacheOptionsType} settings. */
export class MemcachedCacheOptionsValidator extends OptionsValidator<MemcachedCacheOptionsType> {
  constructor() {
    super('MemcachedCacheOptions');
  }
  protected rules(_s: Partial<MemcachedCacheOptionsType>): void {
    this.nonEmptyString('servers');
  }
}

/**
 * The full config paths of one Memcached cache block's leaves.  The global
 * block's copy is `ConfigKeys.cache.memcachedOptions`; a per-name block's is
 * built by {@link memcachedCacheKeysUnder}, since its root contains a name
 * only the application knows.
 */
export type MemcachedCacheKeys = {
  readonly root: string;
  readonly servers: string;
  readonly username: string;
  readonly password: string;
  readonly keyPrefix: string;
};

/** The leaf paths of the Memcached cache block at `root` — see {@link MemcachedCacheKeys}. */
export function memcachedCacheKeysUnder(root: string): MemcachedCacheKeys {
  return {
    root,
    servers: `${root}.servers`,
    username: `${root}.username`,
    password: `${root}.password`,
    keyPrefix: `${root}.key-prefix`,
  };
}

/**
 * Read one `actor-ts.cache.memcached` block, omitting absent leaves so an
 * unset one falls through to the built-in default rather than shadowing it.
 *
 * **An empty string is treated as absent**, on the same rule the Redis reader
 * states: `username`, `password` and `key-prefix` ship as `""` to show the
 * shape of the key, and `MemcachedCacheOptionsValidator` rejects an empty
 * `servers` outright — so an empty string handed on verbatim would configure
 * nothing at best and refuse construction at worst.
 */
export function readMemcachedCacheOptionsFromConfig(
  config: Config,
  keys: MemcachedCacheKeys = ConfigKeys.cache.memcachedOptions,
): Partial<MemcachedCacheOptionsType> {
  const out: { -readonly [K in keyof MemcachedCacheOptionsType]?: MemcachedCacheOptionsType[K] } = {};
  if (config.hasPath(keys.servers) && config.getString(keys.servers) !== '') {
    out.servers = config.getString(keys.servers);
  }
  if (config.hasPath(keys.username) && config.getString(keys.username) !== '') {
    out.username = config.getString(keys.username);
  }
  if (config.hasPath(keys.password) && config.getString(keys.password) !== '') {
    out.password = config.getString(keys.password);
  }
  if (config.hasPath(keys.keyPrefix) && config.getString(keys.keyPrefix) !== '') {
    out.keyPrefix = config.getString(keys.keyPrefix);
  }
  return out;
}

/**
 * Accepted input for the {@link MemcachedCache} constructor: the fluent
 * {@link MemcachedCacheOptionsBuilder} OR a plain
 * {@link MemcachedCacheOptionsType} object.
 */
export type MemcachedCacheOptions = MemcachedCacheOptionsBuilder | Partial<MemcachedCacheOptionsType>;
/** Value alias so `MemcachedCacheOptions.create()` / `new MemcachedCacheOptions()` resolve to the builder. */
export const MemcachedCacheOptions = MemcachedCacheOptionsBuilder;
