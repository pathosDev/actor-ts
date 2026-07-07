/**
 * Fluent builder for {@link HonoBackendSettings}:
 *
 *     new HonoBackend(HonoBackendOptions.create().withMaxBodyBytes(1 << 20))
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { HonoAppLike, HonoBackendSettings } from './HonoBackend.js';

export class HonoBackendOptions extends OptionsBuilder<HonoBackendSettings> {
  /** Start a fresh builder.  Equivalent to `new HonoBackendOptions()`. */
  static create(): HonoBackendOptions {
    return new HonoBackendOptions();
  }

  /** Bring-your-own Hono app (skips the internal `hono` import). */
  withApp(app: HonoAppLike): this {
    return this.set('app', app);
  }

  /** Maximum request body size in bytes.  Default 10 MiB; exceeding it returns 413. */
  withMaxBodyBytes(bytes: number): this {
    return this.set('maxBodyBytes', bytes);
  }
}
