import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { RedisClientLike } from './RedisCache.js';

/** Plain settings-object shape accepted by a {@link RedisCache}. */
export interface RedisCacheOptionsType {
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
}

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
 * Accepted input for the {@link RedisCache} constructor: the fluent
 * {@link RedisCacheOptionsBuilder} OR a plain {@link RedisCacheOptionsType}
 * object.
 */
export type RedisCacheOptions = RedisCacheOptionsBuilder | Partial<RedisCacheOptionsType>;
/** Value alias so `RedisCacheOptions.create()` / `new RedisCacheOptions()` resolve to the builder. */
export const RedisCacheOptions = RedisCacheOptionsBuilder;
