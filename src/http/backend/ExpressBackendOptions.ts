/**
 * All Express-backend option-relevant types live here:
 *
 *   - {@link ExpressBackendOptionsType} — the plain settings-object shape
 *     (what you may also pass as a bare `{ … }` object).
 *   - {@link ExpressBackendOptionsBuilder} — the fluent builder
 *     (`ExpressBackendOptions.create()…`).
 *   - {@link ExpressBackendOptions} — the accepted-input **union**
 *     (`ExpressBackendOptionsBuilder | ExpressBackendOptionsType`), plus a
 *     value alias to the builder so `ExpressBackendOptions.create()` /
 *     `new ExpressBackendOptions()` keep working.
 *
 *     const backendOptions = ExpressBackendOptions.create()
 *       .withMaxBodyBytes(1 << 20);
 *     new ExpressBackend(backendOptions);
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { ExpressAppLike } from './ExpressBackend.js';

/** Plain settings-object shape accepted by an {@link ExpressBackend}. */
export interface ExpressBackendOptionsType {
  /**
   * Bring-your-own app — useful when you already attach custom middleware
   * (CORS, sessions, metrics, …) outside the DSL.  When omitted, a fresh
   * Express app is created via the installed `express` package.
   */
  readonly app?: ExpressAppLike;
  /** Maximum allowed body size in bytes (default: 10 MiB).  Exceeding it returns 413. */
  readonly maxBodyBytes?: number;
}

/** Fluent builder for {@link ExpressBackendOptionsType}. */
export class ExpressBackendOptionsBuilder extends OptionsBuilder<ExpressBackendOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ExpressBackendOptionsBuilder()`. */
  static create(): ExpressBackendOptionsBuilder {
    return new ExpressBackendOptionsBuilder();
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

/** Validates resolved {@link ExpressBackendOptionsType} settings. */
export class ExpressBackendOptionsValidator extends OptionsValidator<ExpressBackendOptionsType> {
  constructor() {
    super('ExpressBackendOptions');
  }
  protected rules(_s: Partial<ExpressBackendOptionsType>): void {
    this.positiveInt('maxBodyBytes');
  }
}

/**
 * Accepted input for the {@link ExpressBackend} constructor: the fluent
 * {@link ExpressBackendOptionsBuilder} OR a plain
 * {@link ExpressBackendOptionsType} object.
 */
export type ExpressBackendOptions = ExpressBackendOptionsBuilder | Partial<ExpressBackendOptionsType>;
/** Value alias so `ExpressBackendOptions.create()` / `new ExpressBackendOptions()` resolve to the builder. */
export const ExpressBackendOptions = ExpressBackendOptionsBuilder;
