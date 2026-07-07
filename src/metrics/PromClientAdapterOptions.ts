import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type {
  PromClientLike,
  PromClientRegistryLike,
} from './PromClientAdapter.js';

/** Plain settings-object shape accepted by {@link promClientRegistry}. */
export interface PromClientAdapterOptionsType {
  /** The prom-client API namespace (`import client from 'prom-client'`). */
  readonly client: PromClientLike;
  /** The prom-client `Registry` to publish into.  Typically `client.register`. */
  readonly registry: PromClientRegistryLike;
  /**
   * Optional name prefix, e.g. `'actor_ts_'`.  Applied to every metric
   * name registered through the adapter.  Default: empty.
   */
  readonly namePrefix?: string;
}

/**
 * Fluent builder for {@link PromClientAdapterOptionsType}:
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
export class PromClientAdapterOptionsBuilder extends OptionsBuilder<PromClientAdapterOptionsType> {
  /** Start a fresh builder.  Equivalent to `new PromClientAdapterOptionsBuilder()`. */
  static create(): PromClientAdapterOptionsBuilder {
    return new PromClientAdapterOptionsBuilder();
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

/**
 * Accepted input for {@link promClientRegistry}: the fluent
 * {@link PromClientAdapterOptionsBuilder} OR a plain
 * {@link PromClientAdapterOptionsType} object.
 */
export type PromClientAdapterOptions = PromClientAdapterOptionsBuilder | Partial<PromClientAdapterOptionsType>;
/** Value alias so `PromClientAdapterOptions.create()` / `new PromClientAdapterOptions()` resolve to the builder. */
export const PromClientAdapterOptions = PromClientAdapterOptionsBuilder;
