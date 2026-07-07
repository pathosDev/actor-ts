import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { MemcachedCacheSettings, MemcachedClientLike } from './MemcachedCache.js';

/**
 * Fluent builder for {@link MemcachedCacheSettings}:
 *
 *     new MemcachedCache(MemcachedCacheOptions.create().withServers('localhost:11211').withKeyPrefix('app:'))
 */
export class MemcachedCacheOptions extends OptionsBuilder<MemcachedCacheSettings> {
  /** Start a fresh builder.  Equivalent to `new MemcachedCacheOptions()`. */
  static create(): MemcachedCacheOptions {
    return new MemcachedCacheOptions();
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
