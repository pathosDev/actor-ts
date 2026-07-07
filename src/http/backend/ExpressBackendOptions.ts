/**
 * Fluent builder for {@link ExpressBackendSettings}:
 *
 *     new ExpressBackend(ExpressBackendOptions.create().withMaxBodyBytes(1 << 20))
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { ExpressAppLike, ExpressBackendSettings } from './ExpressBackend.js';

export class ExpressBackendOptions extends OptionsBuilder<ExpressBackendSettings> {
  /** Start a fresh builder.  Equivalent to `new ExpressBackendOptions()`. */
  static create(): ExpressBackendOptions {
    return new ExpressBackendOptions();
  }

  /** Bring-your-own Express app (skips the internal `express` import). */
  withApp(app: ExpressAppLike): this {
    return this.set('app', app);
  }

  /** Maximum request body size in bytes.  Default 10 MiB; exceeding it returns 413. */
  withMaxBodyBytes(bytes: number): this {
    return this.set('maxBodyBytes', bytes);
  }
}
