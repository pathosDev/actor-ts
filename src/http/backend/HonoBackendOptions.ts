/**
 * All Hono-backend option-relevant types live here:
 *
 *   - {@link HonoBackendOptionsType} — the plain settings-object shape
 *     (what you may also pass as a bare `{ … }` object).
 *   - {@link HonoBackendOptionsBuilder} — the fluent builder
 *     (`HonoBackendOptions.create()…`).
 *   - {@link HonoBackendOptions} — the accepted-input **union**
 *     (`HonoBackendOptionsBuilder | HonoBackendOptionsType`), plus a value
 *     alias to the builder so `HonoBackendOptions.create()` /
 *     `new HonoBackendOptions()` keep working.
 *
 *     const backendOptions = HonoBackendOptions.create()
 *       .withMaxBodyBytes(1 << 20);
 *     new HonoBackend(backendOptions);
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { HonoAppLike } from './HonoBackend.js';

/** Plain settings-object shape accepted by a {@link HonoBackend}. */
export interface HonoBackendOptionsType {
  /**
   * Bring-your-own Hono app — useful if you already registered middleware
   * (CORS, JWT, logger) before handing it off.  When omitted, we import
   * `hono` dynamically and build a fresh app on `listen()`.
   */
  readonly app?: HonoAppLike;
  /** Maximum allowed body size in bytes (default: 10 MiB).  Exceeding it returns 413. */
  readonly maxBodyBytes?: number;
}

/** Fluent builder for {@link HonoBackendOptionsType}. */
export class HonoBackendOptionsBuilder extends OptionsBuilder<HonoBackendOptionsType> {
  /** Start a fresh builder.  Equivalent to `new HonoBackendOptionsBuilder()`. */
  static create(): HonoBackendOptionsBuilder {
    return new HonoBackendOptionsBuilder();
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

/**
 * Accepted input for the {@link HonoBackend} constructor: the fluent
 * {@link HonoBackendOptionsBuilder} OR a plain {@link HonoBackendOptionsType}
 * object.
 */
export type HonoBackendOptions = HonoBackendOptionsBuilder | Partial<HonoBackendOptionsType>;
/** Value alias so `HonoBackendOptions.create()` / `new HonoBackendOptions()` resolve to the builder. */
export const HonoBackendOptions = HonoBackendOptionsBuilder;
