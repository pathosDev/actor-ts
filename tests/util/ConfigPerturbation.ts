import { match } from 'ts-pattern';
import { Config, ConfigError } from '../../src/config/Config.js';
import { parseDuration } from '../../src/config/Duration.js';
import type { ConfigObject, ConfigValue } from '../../src/config/HoconParser.js';
import { parseSize } from '../../src/config/Size.js';

/**
 * One-leaf perturbation of a parsed configuration, and what a reader does
 * with it (#1425).
 *
 * The question the dead-key gate asks of every `reference.conf` leaf is
 * whether some reader *reads* it, and reading is a runtime fact: a reader
 * reads a leaf when its answer depends on the leaf's value.  So a leaf is
 * changed, one at a time, and each registered reader runs twice — over the
 * unchanged config and over the changed one.  A reader that answers
 * differently has read it; a reader that answers the same has not, whatever
 * its source text says.  That is what the substring check this replaces could
 * not tell apart: a key named in a comment, in a sibling's accessor, in a
 * `void keys.x;`, or read into a value the reader then dropped.
 *
 * Only the answer counts.  A reader that *refuses* the new value has shown
 * that it checks the leaf, not that it keeps it: a URL validated and then
 * dropped refuses `perturbed` exactly as a URL that is used does.  Leaves
 * whose reader refuses every value but the members of an enum therefore get
 * another member from {@link PERTURBATION_OVERRIDES}, so there is an answer
 * to compare.
 *
 * The new value keeps the leaf's **kind**, inferred from the shipped literal,
 * and that is load-bearing.  Were `off` perturbed into a word no `getBoolean`
 * accepts, the getter would throw, and a gate that counted that throw as a
 * read would pass a `getBoolean` whose answer is discarded.  A value of the
 * leaf's own kind is one every correct accessor takes, so a reader can only
 * be observed through what it returns.  Which is also why a *kind mismatch*
 * is reported as a failure of the leaf: it means the reader takes the leaf
 * with an accessor of another kind than the literal it ships with, or that
 * the literal cannot suggest the kind and {@link PERTURBATION_OVERRIDES} or
 * {@link KIND_DECLARATIONS} needs an entry.
 *
 * A value of the leaf's own kind cannot catch every accessor of another kind,
 * though: a bare integer reads the same through `getInt`, `getNumber`,
 * `getDuration` and `getBytes`.  So each leaf with a kind a getter checks
 * also gets an **off-kind** value — one its own accessor refuses and the
 * accessor it is most easily confused with accepts (a fraction for an
 * integer, a size for a duration, a duration for a size) — and a reader that
 * *accepts* that value and answers differently reads the leaf with the wrong
 * accessor.
 */

/** What a leaf's literal (or its {@link KIND_DECLARATIONS} entry) says it is. */
export type LeafKind =
  | 'boolean'
  | 'switch'
  | 'integer'
  | 'fraction'
  | 'duration'
  | 'size'
  | 'text'
  | 'list';

/** The two values one leaf is perturbed with. */
export type LeafPerturbation = {
  readonly leaf: string;
  readonly kind: LeafKind;
  /** The value the leaf ships with; `undefined` for a leaf the config does not publish. */
  readonly literal: ConfigValue | undefined;
  /** A value of the leaf's kind that differs from the literal. */
  readonly value: ConfigValue;
  /** A value its own accessor refuses; absent for kinds no getter checks. */
  readonly offKindValue?: ConfigValue;
  /** Why {@link value} was not inferred, when it was not. */
  readonly reason?: string;
};

/** A value a literal cannot suggest, with the reason the inferred one is wrong. */
export type PerturbationOverride = {
  readonly value: ConfigValue;
  readonly reason: string;
};

const ANOTHER_MEMBER = 'the reader refuses any word outside the enum, and a refusal alone is not a read, '
  + 'so only another member gives an answer to compare';

/**
 * Leaves whose inferred perturbation no reader can answer to, though the leaf
 * is read: the reader maps the inferred value onto the answer the literal
 * already gives, refuses every value but its members, or takes it with the
 * accessor of an arm the literal is not in.  The kind is inferred from the
 * override value, not from the literal.
 */
export const PERTURBATION_OVERRIDES: ReadonlyMap<string, PerturbationOverride> = new Map([
  ['actor-ts.cluster.split-brain-resolver.active-strategy', { value: 'keep-majority', reason: ANOTHER_MEMBER }],
  ['actor-ts.cluster.bootstrap.discovery.method', { value: 'dns', reason: ANOTHER_MEMBER }],
  ['actor-ts.http.backend', { value: 'hono', reason: ANOTHER_MEMBER }],
  ['actor-ts.persistence.snapshot-store.object-storage.backend', { value: 'filesystem', reason: ANOTHER_MEMBER }],
  ['actor-ts.persistence.snapshot-store.object-storage.compression.algorithm', { value: 'zstd', reason: ANOTHER_MEMBER }],
  ['actor-ts.persistence.snapshot-store.object-storage.encryption.mode', { value: 'sse-s3', reason: ANOTHER_MEMBER }],
  ['actor-ts.mailbox.default.overflow', { value: 'drop-new', reason: ANOTHER_MEMBER }],
  ['actor-ts.logger.level', {
    value: 'debug',
    reason: 'readLoggerLevelFromConfig maps an unknown level name to info, the level reference.conf ships, '
      + 'so a suffixed name reads exactly like the literal',
  }],
  ['actor-ts.backoff-supervisor.reset-counter', {
    value: '5s',
    reason: 'the leaf is the word after-min-stable or a duration; any other word is parsed as a duration '
      + 'and refused as one, so only the duration arm is a value of the leaf\'s kind',
  }],
  ['actor-ts.offload-pool.size', {
    value: 3,
    reason: 'the leaf is the word auto or a worker count; the count is the arm a suffixed word cannot reach',
  }],
  ['actor-ts.worker-cluster.workers', {
    value: 3,
    reason: 'the leaf is the word auto or a worker count; the count is the arm a suffixed word cannot reach',
  }],
  ['actor-ts.worker-mesh.workers', {
    value: 3,
    reason: 'the leaf is the word auto or a worker count; the count is the arm a suffixed word cannot reach',
  }],
]);

/** A kind a whole-valued literal cannot show, with the reason the leaf has it. */
export type KindDeclaration = {
  readonly kind: LeafKind;
  readonly reason: string;
};

/**
 * Leaves whose literal shows a kind they do not have.  HOCON parses `1.0` as
 * the number `1`, a byte or millisecond count can be written without its
 * unit, and `off` is a member of several enums as well as a switch — so the
 * literal alone cannot tell these from a count or a switch, and the off-kind
 * value of a count or a switch is one their own reader rightly accepts.
 */
export const KIND_DECLARATIONS: ReadonlyMap<string, KindDeclaration> = new Map<string, KindDeclaration>([
  ['actor-ts.dead-letters.store', {
    kind: 'text',
    reason: 'an enum (off | in-memory | persistent); the reader passes the word through to the options validator',
  }],
  ['actor-ts.diagnostics.message-boundary.structured-clone', {
    kind: 'text',
    reason: 'an enum (off | warn | fail); the reader passes the word through to the options validator',
  }],
  ['actor-ts.diagnostics.message-boundary.serializer-round-trip', {
    kind: 'text',
    reason: 'an enum (off | warn | fail); the reader passes the word through to the options validator',
  }],
  ['actor-ts.cluster.failure-detector.phi.unreachable-threshold', {
    kind: 'fraction',
    reason: 'a phi threshold, which takes any positive number; 8 is shipped without a decimal point',
  }],
  ['actor-ts.cluster.failure-detector.phi.down-threshold', {
    kind: 'fraction',
    reason: 'a phi threshold, which takes any positive number; 12 is shipped without a decimal point',
  }],
  ['actor-ts.serialization.read-constraints.max-document-bytes', {
    kind: 'size',
    reason: 'a byte cap shipped as the bare count 0 (no cap)',
  }],
  ['actor-ts.circuit-breaker.default.backoff-factor', {
    kind: 'fraction',
    reason: 'a growth factor; the shipped 1.0 parses as the whole number 1',
  }],
  ['actor-ts.circuit-breaker.default.random-factor', {
    kind: 'fraction',
    reason: 'a jitter fraction; the shipped 0.0 parses as the whole number 0',
  }],
  ['actor-ts.cache.in-memory.time-to-live', {
    kind: 'duration',
    reason: 'a duration shipped as the bare count 0 (entries live forever)',
  }],
  ['actor-ts.cache.in-memory.time-to-idle', {
    kind: 'duration',
    reason: 'a duration shipped as the bare count 0 (a read extends nothing)',
  }],
  ['actor-ts.sharding.passivation.admission-window-proportion', {
    kind: 'fraction',
    reason: 'a proportion of the entity cap; the shipped 0.0 parses as the whole number 0',
  }],
  ['actor-ts.sharding.passivation.admission-filter', {
    kind: 'text',
    reason: 'an enum (off | frequency-sketch); the reader passes the word through to the options validator',
  }],
]);

/** The suffix a text leaf is perturbed with, and the word an off-kind check uses. */
export const PERTURBATION_WORD = 'perturbed';

const SWITCH_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ['on', 'off'], ['off', 'on'],
  ['yes', 'no'], ['no', 'yes'],
  ['true', 'false'], ['false', 'true'],
]);

const QUANTITY = /^(\d+(?:\.\d+)?)(\s*)([A-Za-zµμΜ]+)$/;

function parses(parser: (input: string) => number, input: string): boolean {
  try {
    parser(input);
    return true;
  } catch {
    return false;
  }
}

/** The kind a literal is, read off its JavaScript type and its spelling. */
export function inferKind(literal: ConfigValue): LeafKind {
  if (typeof literal === 'boolean') return 'boolean';
  if (typeof literal === 'number') return Number.isInteger(literal) ? 'integer' : 'fraction';
  if (Array.isArray(literal)) return 'list';
  if (typeof literal === 'string') {
    if (SWITCH_SPELLINGS.has(literal.toLowerCase())) return 'switch';
    const quantity = literal.match(QUANTITY);
    if (quantity) {
      const duration = parses(parseDuration, literal);
      const size = parses(parseSize, literal);
      // Both parsers fold case, so `m` is minutes to one and mebibytes to the
      // other.  The spelling convention decides: `5m` is a duration and `16M`
      // a size — the two readings a reader with the wrong accessor confuses.
      if (duration && size) return quantity[3] === 'M' ? 'size' : 'duration';
      if (duration) return 'duration';
      if (size) return 'size';
    }
    return 'text';
  }
  throw new Error(`no perturbation for a ${literal === null ? 'null' : typeof literal} literal: add an override`);
}

/** `on` → `off`, `YES` → `NO`: the other value, in the literal's own spelling and case. */
function flipSwitch(literal: string): string {
  const flipped = SWITCH_SPELLINGS.get(literal.toLowerCase())!;
  return literal === literal.toUpperCase() ? flipped.toUpperCase() : flipped;
}

/** Strip the binary noise `0.2 + 0.1` leaves behind, so the value is the one a person would write. */
function round(value: number): number {
  return Number(value.toFixed(10));
}

/** A fraction one tenth away, staying inside [0, 1] when it starts there. */
function nudgeFraction(literal: number): number {
  if (literal >= 0 && literal <= 1 && literal + 0.1 > 1) return round(literal - 0.1);
  return round(literal + 0.1);
}

/** The same unit and spacing, one more of it: `5s` → `6s`, `1 MiB` → `2 MiB`. */
function nudgeQuantity(literal: string): string {
  const [, quantity, spacing, unit] = literal.match(QUANTITY)!;
  return `${round(Number(quantity) + 1)}${spacing}${unit}`;
}

/** The same quantity in another unit: `6s` → `6KiB`; a bare count gains the unit. */
function inUnit(value: ConfigValue, unit: string): string {
  if (typeof value === 'number') return `${value}${unit}`;
  const [, quantity, spacing] = (value as string).match(QUANTITY)!;
  return `${quantity}${spacing}${unit}`;
}

function inKindValue(kind: LeafKind, literal: ConfigValue): ConfigValue {
  return match(kind)
    .returnType<ConfigValue>()
    .with('boolean', () => !(literal as boolean))
    .with('switch', () => flipSwitch(literal as string))
    .with('integer', () => (literal as number) + 1)
    .with('fraction', () => nudgeFraction(literal as number))
    .with('duration', 'size', () =>
      (typeof literal === 'number' ? literal + 1 : nudgeQuantity(literal as string)))
    .with('text', () => (literal === '' ? PERTURBATION_WORD : `${String(literal)}-${PERTURBATION_WORD}`))
    .with('list', () => [...(literal as ConfigValue[]), listElement(literal as ConfigValue[])])
    .exhaustive();
}

/** One more element of the list's element type — a string for an empty list. */
function listElement(literal: readonly ConfigValue[]): ConfigValue {
  const sample = literal[0];
  if (typeof sample === 'number') return Math.max(...(literal as number[])) + 1;
  if (typeof sample === 'boolean') return !sample;
  return PERTURBATION_WORD;
}

/**
 * A value the leaf's own accessor refuses, spelled in the kind it is most
 * easily confused with, or `undefined` when no getter checks the kind.
 */
function offKindValue(kind: LeafKind, value: ConfigValue): ConfigValue | undefined {
  return match(kind)
    .returnType<ConfigValue | undefined>()
    // `getInt` refuses a fraction; `getNumber`, `getDuration`, `getBytes`
    // (rounding it) and `getString` all take one.
    .with('integer', () => (value as number) + 0.5)
    // `getNumber` refuses a unit; `getDuration` and `getString` take one.
    .with('fraction', () => `${String(value)}s`)
    // `getDuration` refuses a byte unit and `getBytes` a time unit, each
    // spelled so the other cannot read it (`KiB`, `s`) — unlike `m`.
    .with('duration', () => inUnit(value, 'KiB'))
    .with('size', () => inUnit(value, 's'))
    .with('boolean', 'switch', 'list', () => PERTURBATION_WORD)
    .with('text', () => undefined)
    .exhaustive();
}

/** How `leaf`, shipping as `literal`, is perturbed. */
export function perturbationFor(leaf: string, literal: ConfigValue): LeafPerturbation {
  const override = PERTURBATION_OVERRIDES.get(leaf);
  if (override) {
    const kind = inferKind(override.value);
    return withOffKind({ leaf, kind, literal, value: override.value, reason: override.reason });
  }
  const kind = KIND_DECLARATIONS.get(leaf)?.kind ?? inferKind(literal);
  return withOffKind({ leaf, kind, literal, value: inKindValue(kind, literal) });
}

/**
 * How `leaf`, which the config does not publish, is introduced: set to
 * `value`, from which its kind is read.  The reader's answer to it is
 * classified exactly as a perturbation's is.
 */
export function introductionFor(leaf: string, value: ConfigValue, reason: string): LeafPerturbation {
  return withOffKind({ leaf, kind: inferKind(value), literal: undefined, value, reason });
}

function withOffKind(perturbation: LeafPerturbation): LeafPerturbation {
  const offKind = offKindValue(perturbation.kind, perturbation.value);
  return offKind === undefined ? perturbation : { ...perturbation, offKindValue: offKind };
}

/* ------------------------------ Observation ------------------------------ */

/**
 * One way of reading configuration that the matrix runs: a registered reader,
 * optionally under a context — an overlay that selects the branch a leaf is
 * read in (`active-strategy = keep-majority` before a `keep-majority.role`
 * can be).
 */
export type ConfigProbe = {
  readonly label: string;
  readonly read: (config: Config) => unknown;
  /** Dotted leaf path → value, laid over the reference before every run. */
  readonly overlay?: Readonly<Record<string, ConfigValue>>;
};

export type ReturnedOutcome = { readonly kind: 'returned'; readonly value: unknown };
export type ThrewOutcome = { readonly kind: 'threw'; readonly error: unknown };
export type ProbeOutcome = ReturnedOutcome | ThrewOutcome;

export function runProbe(probe: ConfigProbe, config: Config): ProbeOutcome {
  try {
    return { kind: 'returned', value: probe.read(config) };
  } catch (error) {
    return { kind: 'threw', error };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `error` is a getter refusing a value as the wrong kind — the
 * `ConfigError` of `Config.getX`, or the duration and size parsers' own —
 * rather than a reader refusing it on its merits.
 */
export function isKindMismatch(error: unknown): boolean {
  const message = messageOf(error);
  if (error instanceof ConfigError) {
    return /^Config at "[^"]*" is not a /.test(message) || /^\S+\[\d+\] is not a string \(got /.test(message);
  }
  return /^Invalid (duration|size): /.test(message) || /^Unknown (duration|size) unit "/.test(message);
}

/** A dotted path and a value as the nested object `Config.fromObject` reads. */
export function nestedOverlay(entries: Readonly<Record<string, ConfigValue>>): ConfigObject {
  const root: ConfigObject = {};
  for (const [path, value] of Object.entries(entries)) {
    const segments = path.split('.');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === undefined) node[segment] = {};
      node = node[segment] as ConfigObject;
    }
    node[segments[segments.length - 1]!] = value;
  }
  return root;
}

/** `base` with `entries` laid over it, leaf by leaf. */
export function withOverlay(base: Config, entries: Readonly<Record<string, ConfigValue>>): Config {
  return base.merge(Config.fromObject(nestedOverlay(entries)));
}

/** A probe's baseline: the config it runs over, and its answer there. */
export type ProbeBaseline = {
  readonly probe: ConfigProbe;
  readonly config: Config;
  readonly outcome: ProbeOutcome;
};

export function baselineOf(probe: ConfigProbe, reference: Config): ProbeBaseline {
  const config = probe.overlay ? withOverlay(reference, probe.overlay) : reference;
  return { probe, config, outcome: runProbe(probe, config) };
}

/** What every probe did with one leaf's two values. */
export type LeafVerdict = {
  readonly perturbation: LeafPerturbation;
  /** Probes whose answer changed — the only evidence that counts as a read. */
  readonly observedBy: readonly string[];
  /**
   * Probes that refused the in-kind value on its merits, with their message.
   * Not a read on its own: a reader that checks a value and then drops it
   * refuses the values its check rejects just the same.
   */
  readonly refusedBy: readonly string[];
  /** Probes that refused the in-kind value as the wrong kind, with the getter's message. */
  readonly kindMismatches: readonly string[];
  /** Probes that took the off-kind value and answered differently. */
  readonly offKindAcceptedBy: readonly string[];
};

function changed(outcome: ReturnedOutcome, baseline: ReturnedOutcome): boolean {
  return !Bun.deepEquals(outcome.value, baseline.value, true);
}

/**
 * Run every probe over `perturbation`'s two values and classify the answers.
 * A probe whose baseline threw is skipped here; the registry's sanity tests
 * report it.
 */
export function observeLeaf(perturbation: LeafPerturbation, baselines: readonly ProbeBaseline[]): LeafVerdict {
  const observedBy: string[] = [];
  const refusedBy: string[] = [];
  const kindMismatches: string[] = [];
  const offKindAcceptedBy: string[] = [];
  const configs = new Map<Config, { inKind: Config; offKind?: Config }>();
  for (const baseline of baselines) {
    if (baseline.outcome.kind !== 'returned') continue;
    let perturbed = configs.get(baseline.config);
    if (!perturbed) {
      perturbed = {
        inKind: withOverlay(baseline.config, { [perturbation.leaf]: perturbation.value }),
        ...(perturbation.offKindValue === undefined
          ? {}
          : { offKind: withOverlay(baseline.config, { [perturbation.leaf]: perturbation.offKindValue }) }),
      };
      configs.set(baseline.config, perturbed);
    }
    const label = baseline.probe.label;
    const outcome = runProbe(baseline.probe, perturbed.inKind);
    if (outcome.kind === 'threw') {
      if (isKindMismatch(outcome.error)) kindMismatches.push(`${label}: ${messageOf(outcome.error)}`);
      else refusedBy.push(`${label}: ${messageOf(outcome.error)}`);
    } else if (changed(outcome, baseline.outcome)) {
      observedBy.push(label);
    }
    if (perturbed.offKind) {
      const offKind = runProbe(baseline.probe, perturbed.offKind);
      if (offKind.kind === 'returned' && changed(offKind, baseline.outcome)) offKindAcceptedBy.push(label);
    }
  }
  return { perturbation, observedBy, refusedBy, kindMismatches, offKindAcceptedBy };
}
