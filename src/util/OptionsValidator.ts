/**
 * Base class for per-options validators — the `XOptionsValidator` half of
 * the `XOptions.ts` pattern (see `OptionsBuilder` for the builder half).
 *
 * Before this module existed, option values were checked ad hoc inside
 * individual consumers (and sometimes only on the HOCON path), so a value
 * supplied via the builder or a plain object could bypass a check entirely.
 * A validator runs ONCE, at consume time, on the MERGED settings — after
 * `{ ...defaults, ...options }` / `mergeSettings` — so every input path
 * (builder, plain object, HOCON) hits the same rules, and cross-field
 * rules see the final resolved values.
 *
 * Subclasses implement {@link rules} using the protected check helpers.
 * The helpers take only the FIELD NAME (typo-checked against `T` via
 * {@link KeysMatching}) and read the value from the settings under
 * validation themselves — the name is what the error message needs, and
 * the value cannot be recovered from at runtime if only the value were
 * passed.  Every helper is a no-op when the field is `undefined`: an
 * unset optional always passes (mirroring `stripUndefined` in
 * `mergeSettings`); required-ness is enforced elsewhere (e.g.
 * `BrokerActor.requiredSettings()`).
 *
 * Cross-field rules are plain imperative code at the end of `rules(s)` —
 * guard the participants against `undefined`, then call {@link fail}.
 *
 * Validator instances are throwaway check helpers; the short-lived
 * settings reference held during {@link validate} is harmless (JS is
 * single-threaded and `rules` never re-enters `validate`).
 */

/**
 * An option value that is well-typed but outside its domain — regardless
 * of whether it arrived via the builder, a plain object, or HOCON.
 * (Missing required broker settings keep throwing `BrokerSettingsError`;
 * malformed HOCON keeps throwing `ConfigError` — this error is only for
 * domain validity of present values.)
 */
export class OptionsError extends Error {
  constructor(
    message: string,
    /** Options family the value belongs to, e.g. `'MqttOptions'`. */
    readonly options: string,
    /** Offending field (dotted path for nested fields). */
    readonly field: string,
    /** The rejected value. */
    readonly value?: unknown,
  ) {
    super(message);
    this.name = 'OptionsError';
  }
}

/**
 * Keys of `T` whose (non-nullable) value type is assignable to `V` —
 * makes e.g. `positiveNumber` on a string field a compile error, and any
 * typo in a field name one too.
 */
type KeysMatching<T, V> = {
  [K in keyof T]-?: NonNullable<T[K]> extends V ? K : never;
}[keyof T] & string;

export abstract class OptionsValidator<T extends object> {
  /** Settings under validation — only set for the duration of {@link validate}. */
  private s: Partial<T> | undefined;

  protected constructor(
    /** Options family, prefixed to every error message, e.g. `'MqttOptions'`. */
    private readonly optionsName: string,
  ) {}

  /**
   * Check the (merged) settings; throws {@link OptionsError} on the first
   * violation.  Unset (`undefined`) fields always pass.
   */
  validate(settings: Partial<T>): void {
    this.s = settings;
    try {
      this.rules(settings);
    } finally {
      this.s = undefined;
    }
  }

  /**
   * Subclass: the field and cross-field rules.  `s` is the same object
   * passed to {@link validate} — use it for cross-field guards; the
   * per-field helpers read from it implicitly.
   */
  protected abstract rules(s: Partial<T>): void;

  /* --------------------------- check helpers --------------------------- */
  /* All helpers: no-op when the field is undefined, throw OptionsError    */
  /* otherwise the value violates the rule.                                */

  /** Finite and `> 0` — durations, intervals, factors. */
  protected positiveNumber(field: KeysMatching<T, number>): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      this.fail(field, 'must be a positive finite number', v);
    }
  }

  /** Integer `>= 1` — counts like quorum sizes, shard counts, retries. */
  protected positiveInt(field: KeysMatching<T, number>): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      this.fail(field, 'must be an integer >= 1', v);
    }
  }

  /** Finite and `>= 0`. */
  protected nonNegativeNumber(field: KeysMatching<T, number>): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      this.fail(field, 'must be a non-negative finite number', v);
    }
  }

  /** Integer `>= 0` — buffer limits, logical DB indexes. */
  protected nonNegativeInt(field: KeysMatching<T, number>): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      this.fail(field, 'must be an integer >= 0', v);
    }
  }

  /** Finite number in `[min, max]` (inclusive). */
  protected numberInRange(field: KeysMatching<T, number>, min: number, max: number): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      this.fail(field, `must be a number in [${min}, ${max}]`, v);
    }
  }

  /** Integer TCP/UDP port, `1–65535`. */
  protected port(field: KeysMatching<T, number>): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
      this.fail(field, 'must be an integer port in [1, 65535]', v);
    }
  }

  /** Exactly one of the allowed literals — enum-like fields. */
  protected oneOf<K extends keyof T & string>(
    field: K,
    allowed: readonly NonNullable<T[K]>[],
  ): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (!allowed.includes(v as NonNullable<T[K]>)) {
      this.fail(field, `must be one of ${allowed.map((a) => this.show(a)).join(', ')}`, v);
    }
  }

  /** Non-empty string. */
  protected nonEmptyString(field: KeysMatching<T, string>): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (typeof v !== 'string' || v.length === 0) {
      this.fail(field, 'must be a non-empty string', v);
    }
  }

  /** Array with at least one entry. */
  protected nonEmptyArray(field: KeysMatching<T, readonly unknown[]>): void {
    const v = this.read(field);
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length === 0) {
      this.fail(field, 'must contain at least one entry', v);
    }
  }

  /**
   * Parseable URL (via `new URL()`), optionally restricted to the given
   * protocols (without the trailing `:`, e.g. `['mqtt', 'mqtts']`).
   */
  protected url(field: KeysMatching<T, string>, protocols?: readonly string[]): void {
    const v = this.read(field);
    if (v === undefined) return;
    let parsed: URL;
    try {
      parsed = new URL(v as string);
    } catch {
      this.fail(field, 'must be a valid URL', v);
    }
    if (protocols !== undefined) {
      const proto = parsed.protocol.replace(/:$/, '');
      if (!protocols.includes(proto)) {
        this.fail(field, `must use protocol ${protocols.join(', ')}`, v);
      }
    }
  }

  /**
   * Throw a formatted {@link OptionsError} — for cross-field and other
   * bespoke rules.  `field` is free-form so nested paths like
   * `'circuitBreaker.resetMs'` work.
   */
  protected fail(field: string, reason: string, value?: unknown): never {
    const got = arguments.length >= 3 ? ` (got ${this.show(value)})` : '';
    throw new OptionsError(
      `${this.optionsName}: ${field} ${reason}${got}`,
      this.optionsName,
      field,
      value,
    );
  }

  /** Value of `field` in the settings under validation. */
  private read(field: string): unknown {
    if (this.s === undefined) {
      throw new Error('OptionsValidator check helpers must be called from within rules()');
    }
    return (this.s as Record<string, unknown>)[field];
  }

  /** Render a value for an error message — strings quoted, rest via String(). */
  private show(value: unknown): string {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  }
}
