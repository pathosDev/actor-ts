import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by {@link ClusterClientReceptionist.start}. */
export type ClusterClientReceptionistOptionsType = {
  /**
   * Default ask timeout (ms) when a client envelope carries an `askId`.
   * Default: 5_000.
   */
  readonly askTimeoutMs?: number;
};

/**
 * Fluent builder for {@link ClusterClientReceptionistOptionsType}:
 *
 *     receptionist.start(
 *       cluster,
 *       ClusterClientReceptionistOptions.create().withAskTimeoutMs(3_000),
 *     );
 */
export class ClusterClientReceptionistOptionsBuilder extends OptionsBuilder<ClusterClientReceptionistOptionsType> {
  /** Start a fresh builder. */
  static create(): ClusterClientReceptionistOptionsBuilder {
    return new ClusterClientReceptionistOptionsBuilder();
  }

  /** Default ask timeout (ms) for client envelopes carrying an `askId`.  Default 5 s. */
  withAskTimeoutMs(ms: number): this {
    return this.set('askTimeoutMs', ms);
  }
}

/** Validates resolved {@link ClusterClientReceptionistOptionsType} settings. */
export class ClusterClientReceptionistOptionsValidator extends OptionsValidator<ClusterClientReceptionistOptionsType> {
  constructor() {
    super('ClusterClientReceptionistOptions');
  }
  protected rules(_s: Partial<ClusterClientReceptionistOptionsType>): void {
    this.positiveNumber('askTimeoutMs');
  }
}

/**
 * The slice of {@link ClusterClientReceptionistOptionsType} that
 * `actor-ts.cluster.client.receptionist` can state — today the whole of it.
 */
export type ClusterClientReceptionistConfigDefaults =
  Partial<Pick<ClusterClientReceptionistOptionsType, 'askTimeoutMs'>>;

/**
 * Read `actor-ts.cluster.client.receptionist.*`.
 *
 * `config` is **required and never defaulted**, which is the asymmetry with
 * `readClusterClientOptionsFromConfig` on the other side of the same block.
 * The client is standalone and has to load its own config; the receptionist is
 * a per-system extension and always has `system.config` in scope, so a
 * `Config.load()` here would consult the filesystem for a value the caller was
 * already holding — and could disagree with the system it runs inside.
 *
 * An absent leaf stays absent rather than arriving as an explicit `undefined`,
 * for the reason {@link withClusterClientReceptionistConfigDefaults} spreads
 * it: a key present with `undefined` would shadow the built-in default under it.
 */
export function readClusterClientReceptionistOptionsFromConfig(
  config: Config,
): ClusterClientReceptionistConfigDefaults {
  const keys = ConfigKeys.cluster.client.receptionist;
  const out: {
    -readonly [K in keyof ClusterClientReceptionistConfigDefaults]:
      ClusterClientReceptionistConfigDefaults[K]
  } = {};
  if (config.hasPath(keys.askTimeout)) {
    out.askTimeoutMs = config.getDuration(keys.askTimeout);
  }
  return out;
}

/**
 * Layer the config block under the caller's options — **explicit options >
 * HOCON > built-in defaults**.  The result is what
 * {@link ClusterClientReceptionistOptionsValidator} sees, so a bad duration in
 * a config file is rejected exactly like a bad one in code.
 */
export function withClusterClientReceptionistConfigDefaults(
  options: Partial<ClusterClientReceptionistOptionsType>,
  config: Config,
): ClusterClientReceptionistOptionsType {
  return mergeOptions<ClusterClientReceptionistOptionsType>(
    {},
    readClusterClientReceptionistOptionsFromConfig(config),
    options,
  );
}

/**
 * Accepted input for {@link ClusterClientReceptionist.start}: the fluent
 * {@link ClusterClientReceptionistOptionsBuilder} OR a plain
 * {@link ClusterClientReceptionistOptionsType} object.
 */
export type ClusterClientReceptionistOptions =
  | ClusterClientReceptionistOptionsBuilder
  | Partial<ClusterClientReceptionistOptionsType>;
/** Value alias so `ClusterClientReceptionistOptions.create()` / `new ClusterClientReceptionistOptions()` resolve to the builder. */
export const ClusterClientReceptionistOptions = ClusterClientReceptionistOptionsBuilder;
