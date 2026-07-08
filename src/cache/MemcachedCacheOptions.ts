import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { MemcachedClientLike } from './MemcachedCache.js';

/** Plain options-object shape accepted by a {@link MemcachedCache}. */
export interface MemcachedCacheOptionsType {
  /** Comma-separated server list, e.g. `'localhost:11211'`.  Default: `'localhost:11211'`. */
  readonly servers?: string;
  /** Optional username/password for SASL auth. */
  readonly username?: string;
  readonly password?: string;
  /** Optional key prefix (server-side, applied to every operation). */
  readonly keyPrefix?: string;
  /** Pre-built memjs client — bypass internal construction. */
  readonly client?: MemcachedClientLike;
}

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

/**
 * Accepted input for the {@link MemcachedCache} constructor: the fluent
 * {@link MemcachedCacheOptionsBuilder} OR a plain
 * {@link MemcachedCacheOptionsType} object.
 */
export type MemcachedCacheOptions = MemcachedCacheOptionsBuilder | Partial<MemcachedCacheOptionsType>;
/** Value alias so `MemcachedCacheOptions.create()` / `new MemcachedCacheOptions()` resolve to the builder. */
export const MemcachedCacheOptions = MemcachedCacheOptionsBuilder;
