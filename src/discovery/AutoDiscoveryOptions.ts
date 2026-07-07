import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { AutoDiscoverySettings } from './autoDiscovery.js';

/**
 * Fluent builder for {@link AutoDiscoverySettings} — the input to
 * {@link autoDiscovery} and {@link singleProviderDiscovery}.
 *
 *     autoDiscovery(
 *       AutoDiscoveryOptions.create().withSystemName('my-system').withPort(2552),
 *     );
 */
export class AutoDiscoveryOptions extends OptionsBuilder<AutoDiscoverySettings> {
  /** Start a fresh builder.  Equivalent to `new AutoDiscoveryOptions()`. */
  static create(): AutoDiscoveryOptions {
    return new AutoDiscoveryOptions();
  }

  /** ActorSystem name to stamp on discovered NodeAddresses. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }

  /** Cluster remoting port to pair each discovered IP with. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Pre-mapped env lookup (defaults to `process.env` at call time). */
  withEnv(env: Record<string, string | undefined>): this {
    return this.set('env', env);
  }

  /** Logger for individual provider failures.  Default: no-op. */
  withLog(log: (msg: string, err?: unknown) => void): this {
    return this.set('log', log);
  }
}
