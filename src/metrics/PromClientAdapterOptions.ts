import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type {
  PromClientAdapterSettings,
  PromClientLike,
  PromClientRegistryLike,
} from './PromClientAdapter.js';

/**
 * Fluent builder for {@link PromClientAdapterSettings}:
 *
 *     promClientRegistry(
 *       PromClientAdapterOptions.create()
 *         .withClient(client)
 *         .withRegistry(client.register)
 *         .withNamePrefix('actor_ts_'),
 *     )
 *
 * `withClient` + `withRegistry` are mandatory — the bridge has nothing to
 * publish into without them.
 */
export class PromClientAdapterOptions extends OptionsBuilder<PromClientAdapterSettings> {
  /** Start a fresh builder.  Equivalent to `new PromClientAdapterOptions()`. */
  static create(): PromClientAdapterOptions {
    return new PromClientAdapterOptions();
  }

  /** The prom-client API namespace (`import client from 'prom-client'`). */
  withClient(client: PromClientLike): this {
    return this.set('client', client);
  }

  /** The prom-client `Registry` to publish into.  Typically `client.register`. */
  withRegistry(registry: PromClientRegistryLike): this {
    return this.set('registry', registry);
  }

  /** Name prefix, e.g. `'actor_ts_'`, applied to every registered metric name.  Default: empty. */
  withNamePrefix(namePrefix: string): this {
    return this.set('namePrefix', namePrefix);
  }
}
