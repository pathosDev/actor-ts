import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { RedisClientLike } from './RedisCache.js';

/**
 * Built-in default logical database, published as
 * `actor-ts.cache.redis.db`.  `host` and `port` have no constant on purpose:
 * they are comment-only in `reference.conf` so that "unset" stays
 * expressible, and unset is what lets ioredis apply its own 127.0.0.1:6379.
 */
export const DEFAULT_REDIS_DB = 0;

/** Plain options-object shape accepted by a {@link RedisCache}. */
export type RedisCacheOptionsType = {
  /**
   * Redis URL (e.g. `redis://localhost:6379`) — passed straight to the
   * ioredis constructor.  Mutually exclusive with `host`/`port`.
   */
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
  readonly db?: number;
  /**
   * Optional key prefix prepended to every key.  Useful when a single
   * Redis instance is shared by multiple actor systems / environments.
   */
  readonly keyPrefix?: string;
  /**
   * Pre-built ioredis client — bypass internal construction (advanced
   * usage: connection sharing, custom retry strategies, Redis Cluster).
   */
  readonly client?: RedisClientLike;
};

/**
 * Fluent builder for {@link RedisCacheOptionsType}:
 *
 *     new RedisCache(RedisCacheOptions.create().withUrl('redis://localhost:6379').withKeyPrefix('app:'))
 */
export class RedisCacheOptionsBuilder extends OptionsBuilder<RedisCacheOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RedisCacheOptionsBuilder()`. */
  static create(): RedisCacheOptionsBuilder {
    return new RedisCacheOptionsBuilder();
  }

  /** Redis URL (e.g. `redis://localhost:6379`).  Mutually exclusive with `host`/`port`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Redis host — used with `withPort` when no `withUrl` is given. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Redis port — used with `withHost` when no `withUrl` is given. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Redis password (AUTH). */
  withPassword(password: string): this {
    return this.set('password', password);
  }

  /** Redis logical database index. */
  withDb(db: number): this {
    return this.set('db', db);
  }

  /** Key prefix prepended to every key — isolates shared instances by system/env. */
  withKeyPrefix(prefix: string): this {
    return this.set('keyPrefix', prefix);
  }

  /** Pre-built ioredis client — bypass internal construction (connection sharing, Cluster). */
  withClient(client: RedisClientLike): this {
    return this.set('client', client);
  }
}

/**
 * Validates resolved {@link RedisCacheOptionsType} settings: a valid Redis
 * `url`, a well-ranged `port` / logical `db`, and the documented
 * mutual-exclusivity of `url` with `host`/`port`.
 */
export class RedisCacheOptionsValidator extends OptionsValidator<RedisCacheOptionsType> {
  constructor() {
    super('RedisCacheOptions');
  }
  protected rules(s: Partial<RedisCacheOptionsType>): void {
    this.url('url', ['redis', 'rediss']);
    this.port('port');
    this.nonNegativeInt('db');
    if (s.url !== undefined && (s.host !== undefined || s.port !== undefined)) {
      this.fail('url', 'is mutually exclusive with host/port');
    }
  }
}

/**
 * The full config paths of one Redis cache block's leaves.  The global
 * block's copy is `ConfigKeys.cache.redisOptions`; a per-name block's is
 * built by {@link redisCacheKeysUnder}, since its root contains a name only
 * the application knows.
 */
export type RedisCacheKeys = {
  readonly root: string;
  readonly url: string;
  readonly host: string;
  readonly port: string;
  readonly db: string;
  readonly keyPrefix: string;
  readonly password: string;
};

/** The leaf paths of the Redis cache block at `root` — see {@link RedisCacheKeys}. */
export function redisCacheKeysUnder(root: string): RedisCacheKeys {
  return {
    root,
    url: `${root}.url`,
    host: `${root}.host`,
    port: `${root}.port`,
    db: `${root}.db`,
    keyPrefix: `${root}.key-prefix`,
    password: `${root}.password`,
  };
}

/**
 * Read one `actor-ts.cache.redis` block, omitting absent leaves so an unset
 * one falls through to the built-in default instead of shadowing it — the
 * rule `mergeOptions` encodes.
 *
 * **An empty string is treated as absent**, for every string leaf.  The block
 * publishes `url`, `key-prefix` and `password` as `""` so an operator can see
 * the names and the nesting, and passing those through verbatim would break
 * the cache rather than configure it: `RedisCacheOptionsValidator` runs
 * `new URL('')`, which throws, so a published `url = ""` handed on unchanged
 * would make every config-built Redis cache fail construction unconditionally.
 * Uniform is also the honest rule — an intentionally empty `key-prefix` is
 * indistinguishable from an unset one, and both mean the same thing, since the
 * built-in default already is `''`.
 *
 * `client` has no leaf and cannot have one: HOCON expresses values, not a
 * pre-built ioredis connection.
 */
export function readRedisCacheOptionsFromConfig(
  config: Config,
  keys: RedisCacheKeys = ConfigKeys.cache.redisOptions,
): Partial<RedisCacheOptionsType> {
  const out: { -readonly [K in keyof RedisCacheOptionsType]?: RedisCacheOptionsType[K] } = {};
  if (config.hasPath(keys.url) && config.getString(keys.url) !== '') out.url = config.getString(keys.url);
  if (config.hasPath(keys.host) && config.getString(keys.host) !== '') out.host = config.getString(keys.host);
  if (config.hasPath(keys.port)) out.port = config.getInt(keys.port);
  if (config.hasPath(keys.db)) out.db = config.getInt(keys.db);
  if (config.hasPath(keys.keyPrefix) && config.getString(keys.keyPrefix) !== '') {
    out.keyPrefix = config.getString(keys.keyPrefix);
  }
  if (config.hasPath(keys.password) && config.getString(keys.password) !== '') {
    out.password = config.getString(keys.password);
  }
  return out;
}

/**
 * Accepted input for the {@link RedisCache} constructor: the fluent
 * {@link RedisCacheOptionsBuilder} OR a plain {@link RedisCacheOptionsType}
 * object.
 */
export type RedisCacheOptions = RedisCacheOptionsBuilder | Partial<RedisCacheOptionsType>;
/** Value alias so `RedisCacheOptions.create()` / `new RedisCacheOptions()` resolve to the builder. */
export const RedisCacheOptions = RedisCacheOptionsBuilder;
