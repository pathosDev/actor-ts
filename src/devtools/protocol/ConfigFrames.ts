/**
 * The `config.resolved` pull (#553) — every HOCON key, its effective
 * value, and which layer put it there.
 *
 * "Why is this setting not what I wrote?" is a question with three
 * possible answers — the bundled default won, `application.conf` won, or
 * a code override won — and a merged tree alone cannot tell you which.
 * So the panel reports the source per key rather than only the value.
 */

/** Which layer a key's effective value came from. */
export type ConfigSource = 'reference' | 'application' | 'override';

/** One resolved key. */
export type ResolvedConfigEntry = {
  /** Full dotted path, e.g. `actor-ts.cluster.seed-nodes`. */
  readonly path: string;
  /**
   * The effective value, sanitised for the wire.
   *
   * Lists and nested objects arrive as they are — a seed-node list is a
   * list, and flattening it to a string would make it unreadable exactly
   * where reading it matters.
   */
  readonly value: unknown;
  /** Which layer won. */
  readonly source: ConfigSource;
  /**
   * True when a lower layer also set this key.
   *
   * The interesting keys in a misbehaving system are the overridden ones,
   * and a source alone does not say whether anything was displaced.
   */
  readonly overridden: boolean;
  /** True when the value was cut to fit the wire limits. */
  readonly truncated: boolean;
};

/** What `config.resolved` answers. */
export type ResolvedConfigResult = {
  readonly entries: ReadonlyArray<ResolvedConfigEntry>;
  /**
   * Where `application.conf` was read from, or `null` when there was none.
   *
   * Shown because "my file is being ignored" and "my file says something
   * else" are different problems, and the path is what separates them.
   */
  readonly applicationPath: string | null;
  /**
   * False when this config was not built by `Config.load` and so has no
   * layers to attribute against — every entry is then reported as
   * `reference`, which would be a guess rather than an answer.
   */
  readonly attributed: boolean;
};

/** Keys whose values are redacted before they leave the process. */
export const CONFIG_SECRET_PATTERN = /pass|secret|token|key|credential|auth/i;

/** What a redacted value is replaced with. */
export const CONFIG_REDACTED = '<redacted>';
