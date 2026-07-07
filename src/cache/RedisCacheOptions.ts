import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { RedisCacheSettings, RedisClientLike } from './RedisCache.js';

/**
 * Fluent builder for {@link RedisCacheSettings}:
 *
 *     new RedisCache(RedisCacheOptions.create().withUrl('redis://localhost:6379').withKeyPrefix('app:'))
 */
export class RedisCacheOptions extends OptionsBuilder<RedisCacheSettings> {
  /** Start a fresh builder.  Equivalent to `new RedisCacheOptions()`. */
  static create(): RedisCacheOptions {
    return new RedisCacheOptions();
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
