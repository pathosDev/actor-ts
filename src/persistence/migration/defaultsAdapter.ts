import type { EventAdapter, OutboundFrame, SnapshotAdapter, StoredFrame } from './Adapter.js';
import { MigrationError } from './Envelope.js';

/**
 * Spec for `defaultsAdapter` / `defaultsSnapshotAdapter`.
 *
 *   manifest        — stable type identity, e.g. 'BankAccount.Deposited'
 *   currentVersion  — version emitted by *this* code revision
 *   defaults[fromV] — fields to merge in when reading a payload at
 *                     version fromV that is then carried forward to
 *                     version fromV+1 by simple object spread
 *
 * The merge is `{ ...defaults[fromV], ...payload }` — the stored payload
 * always wins, so existing fields are never overwritten by defaults.
 * Run repeatedly for every step on the path stored→currentVersion.
 */
export interface DefaultsAdapterSpec<E> {
  readonly manifest: string;
  readonly currentVersion: number;
  readonly defaults: { readonly [fromVersion: number]: Partial<E> };
}

/**
 * Build an `EventAdapter` that handles **purely additive** evolution:
 * every step from the stored version up to `currentVersion` merges in a
 * fixed set of default field values for the fields added at that step.
 *
 *   // v1 → v2 added a `currency: 'USD' | 'EUR'` field
 *   const adapter = defaultsAdapter<DepositedV2>({
 *     manifest: 'BankAccount.Deposited',
 *     currentVersion: 2,
 *     defaults: { 1: { currency: 'USD' } },
 *   });
 *
 * Limitations — this helper only handles **adding new fields with constant
 * defaults**.  Renames, type changes, splits, merges, derived fields all
 * require a hand-written `MigrationChain`.  When in doubt, write the
 * chain.
 */
export function defaultsAdapter<E extends object>(spec: DefaultsAdapterSpec<E>): EventAdapter<E, E> {
  validateSpec(spec);
  return {
    manifest: () => spec.manifest,
    toJournal: (event: E): OutboundFrame<E> => ({
      manifest: spec.manifest,
      version: spec.currentVersion,
      payload: event,
    }),
    fromJournal: (stored: StoredFrame): E => upcastByDefaults(stored, spec) as E,
  };
}

/**
 * Same shape as `defaultsAdapter` but returns a `SnapshotAdapter` —
 * convenience alias for snapshot / durable-state cases where the same
 * additive semantics apply to the state record.
 */
export function defaultsSnapshotAdapter<S extends object>(spec: DefaultsAdapterSpec<S>): SnapshotAdapter<S, S> {
  validateSpec(spec);
  return {
    manifest: () => spec.manifest,
    toJournal: (state: S): OutboundFrame<S> => ({
      manifest: spec.manifest,
      version: spec.currentVersion,
      payload: state,
    }),
    fromJournal: (stored: StoredFrame): S => upcastByDefaults(stored, spec) as S,
  };
}

/* ------------------------------ internals -------------------------------- */

function validateSpec<E>(spec: DefaultsAdapterSpec<E>): void {
  if (!Number.isInteger(spec.currentVersion) || spec.currentVersion < 1) {
    throw new Error(`defaultsAdapter currentVersion must be a positive integer, got ${spec.currentVersion}`);
  }
  for (const k of Object.keys(spec.defaults)) {
    const fromVersion = Number(k);
    if (!Number.isInteger(fromVersion) || fromVersion < 1) {
      throw new Error(`defaultsAdapter defaults keys must be positive integers, got '${k}'`);
    }
    if (fromVersion >= spec.currentVersion) {
      throw new Error(
        `defaultsAdapter has defaults for v${fromVersion} but currentVersion is ${spec.currentVersion} `
        + `(defaults must apply to versions strictly less than currentVersion)`,
      );
    }
  }
}

function upcastByDefaults<E>(stored: StoredFrame, spec: DefaultsAdapterSpec<E>): unknown {
  if (stored.manifest !== spec.manifest) {
    throw new MigrationError(
      `manifest mismatch: defaultsAdapter is for '${spec.manifest}', got '${stored.manifest}'`,
      stored.manifest, stored.version,
    );
  }
  if (stored.version > spec.currentVersion) {
    throw new MigrationError(
      `cannot downgrade '${stored.manifest}' from v${stored.version} to v${spec.currentVersion}`,
      stored.manifest, stored.version,
    );
  }
  let payload = stored.payload as Record<string, unknown>;
  for (let v = stored.version; v < spec.currentVersion; v++) {
    const fill = spec.defaults[v] as Record<string, unknown> | undefined;
    if (fill) payload = { ...fill, ...payload };
  }
  return payload;
}
