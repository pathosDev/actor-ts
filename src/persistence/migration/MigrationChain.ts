import { MigrationError } from './Envelope.js';
import type { OutboundFrame, StoredFrame } from './Adapter.js';

/**
 * One step in an upcaster pipeline — a pure function that maps a payload
 * at version `fromVersion` to one at version `toVersion`.  Steps are
 * normally consecutive (`fromVersion + 1 === toVersion`); larger jumps
 * are allowed but rare.
 */
export interface MigrationStep<From = unknown, To = unknown> {
  readonly fromVersion: number;
  readonly toVersion: number;
  upcast(from: From): To;
}

/**
 * Inverse of {@link MigrationStep} — maps a current-shape payload back
 * to an older shape on the **write** path (#7).  Used during rolling
 * deployments where v2 nodes need to keep emitting v1 events for as
 * long as v1 readers are still in the cluster.  Steps move backward:
 * `fromVersion > toVersion`, typically `toVersion = fromVersion - 1`.
 */
export interface DowncastStep<From = unknown, To = unknown> {
  readonly fromVersion: number;
  readonly toVersion: number;
  downcast(from: From): To;
}

/**
 * Linear chain of `MigrationStep`s for a single manifest, terminating at
 * a `currentVersion` known to the running code.  On `upcast(stored)`, the
 * chain locates the step starting at `stored.version` and applies steps
 * forward until it reaches `currentVersion`.
 *
 * The chain is intentionally narrow: one manifest, one current version,
 * one linear path.  Multiple types → multiple chains, kept inside an
 * `EventAdapter.fromJournal` switch by manifest.
 *
 *   const chain = MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2)
 *     .add({ fromVersion: 1, toVersion: 2,
 *            upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) });
 *
 * `chain.upcast({ manifest: 'BankAccount.Deposited', version: 1, payload })`
 * returns a `DepositedV2`.
 *
 * Errors:
 *   - manifest mismatch → `MigrationError`
 *   - `stored.version > currentVersion` (downgrade) → `MigrationError`
 *   - no step available at the current cursor before `currentVersion` is
 *     reached (chain gap) → `MigrationError` with the gap printed.
 */
export class MigrationChain<Current> {
  private readonly steps = new Map<number, MigrationStep>();
  private readonly downsteps = new Map<number, DowncastStep>();

  private constructor(
    private readonly _manifest: string,
    private readonly _currentVersion: number,
  ) {
    if (!Number.isInteger(_currentVersion) || _currentVersion < 1) {
      throw new Error(`MigrationChain currentVersion must be a positive integer, got ${_currentVersion}`);
    }
  }

  /** Build an empty chain for `manifest` whose latest known version is `currentVersion`. */
  static for<C>(manifest: string, currentVersion: number): MigrationChain<C> {
    return new MigrationChain<C>(manifest, currentVersion);
  }

  /** Append an upcaster.  Returns `this` for chaining. */
  add<F, T>(step: MigrationStep<F, T>): MigrationChain<Current> {
    if (step.fromVersion >= step.toVersion) {
      throw new Error(`MigrationStep must move forward: fromVersion ${step.fromVersion} >= toVersion ${step.toVersion}`);
    }
    if (step.toVersion > this._currentVersion) {
      throw new Error(
        `MigrationStep targets v${step.toVersion} but chain currentVersion is ${this._currentVersion}`,
      );
    }
    const existing = this.steps.get(step.fromVersion);
    if (existing) {
      throw new Error(
        `MigrationChain already has a step starting at v${step.fromVersion} (→ v${existing.toVersion}); cannot add another`,
      );
    }
    this.steps.set(step.fromVersion, step as MigrationStep);
    return this;
  }

  /**
   * Append a downcaster — the inverse of {@link MigrationStep}.
   * Required when the actor is going to be configured with a
   * `writeVersion` lower than `currentVersion` (#7).  Steps move
   * **backward**: `fromVersion > toVersion`.
   *
   *   chain.addDown({
   *     fromVersion: 2, toVersion: 1,
   *     downcast: (e: DepositedV2): DepositedV1 => {
   *       const { currency, ...rest } = e; void currency; return rest;
   *     },
   *   });
   */
  addDown<F, T>(step: DowncastStep<F, T>): MigrationChain<Current> {
    if (step.fromVersion <= step.toVersion) {
      throw new Error(
        `DowncastStep must move backward: fromVersion ${step.fromVersion} <= toVersion ${step.toVersion}`,
      );
    }
    if (step.fromVersion > this._currentVersion) {
      throw new Error(
        `DowncastStep starts at v${step.fromVersion} but chain currentVersion is ${this._currentVersion}`,
      );
    }
    if (step.toVersion < 1) {
      throw new Error(`DowncastStep targets v${step.toVersion} which is below the v1 floor`);
    }
    const existing = this.downsteps.get(step.fromVersion);
    if (existing) {
      throw new Error(
        `MigrationChain already has a downcaster starting at v${step.fromVersion} (→ v${existing.toVersion}); cannot add another`,
      );
    }
    this.downsteps.set(step.fromVersion, step as DowncastStep);
    return this;
  }

  /** Manifest this chain is bound to. */
  get manifest(): string { return this._manifest; }

  /** Latest version this chain knows how to produce. */
  get currentVersion(): number { return this._currentVersion; }

  /** Apply the chain to a stored frame, returning a current-version value. */
  upcast(stored: StoredFrame): Current {
    if (stored.manifest !== this._manifest) {
      throw new MigrationError(
        `manifest mismatch: chain is for '${this._manifest}', got '${stored.manifest}'`,
        stored.manifest, stored.version,
      );
    }
    if (stored.version > this._currentVersion) {
      throw new MigrationError(
        `cannot downgrade '${stored.manifest}' from v${stored.version} to v${this._currentVersion}`,
        stored.manifest, stored.version,
      );
    }
    let cursor = stored.version;
    let payload: unknown = stored.payload;
    while (cursor < this._currentVersion) {
      const step = this.steps.get(cursor);
      if (!step) {
        throw new MigrationError(
          `no upcaster registered for '${stored.manifest}' starting at v${cursor} `
          + `(target v${this._currentVersion}); add a MigrationStep with fromVersion=${cursor}`,
          stored.manifest, stored.version,
        );
      }
      payload = step.upcast(payload);
      cursor = step.toVersion;
    }
    return payload as Current;
  }

  /**
   * Convert a current-shape value down to `targetVersion` for a
   * write-with-old-shape rolling deploy (#7).  Walks the registered
   * downcasters from `currentVersion` toward `targetVersion`.
   *
   * Errors:
   *   - `targetVersion > currentVersion` → `MigrationError` (we're
   *     already at or above the target; user should call `toJournalAt`
   *     with `version: currentVersion`).
   *   - `targetVersion < 1` → `MigrationError`.
   *   - chain gap (no downcaster for the current cursor) →
   *     `MigrationError` with the missing step printed.
   */
  downcast(current: Current, targetVersion: number): unknown {
    if (!Number.isInteger(targetVersion) || targetVersion < 1) {
      throw new MigrationError(
        `targetVersion must be a positive integer, got ${targetVersion}`,
        this._manifest, this._currentVersion,
      );
    }
    if (targetVersion > this._currentVersion) {
      throw new MigrationError(
        `cannot downcast '${this._manifest}' from current v${this._currentVersion} to v${targetVersion}: target is newer`,
        this._manifest, this._currentVersion,
      );
    }
    let cursor = this._currentVersion;
    let payload: unknown = current;
    while (cursor > targetVersion) {
      const step = this.downsteps.get(cursor);
      if (!step) {
        throw new MigrationError(
          `no downcaster registered for '${this._manifest}' starting at v${cursor} `
          + `(target v${targetVersion}); add a DowncastStep with fromVersion=${cursor}`,
          this._manifest, this._currentVersion,
        );
      }
      payload = step.downcast(payload);
      cursor = step.toVersion;
    }
    return payload;
  }

  /**
   * Build an `OutboundFrame` for the write path at `writeVersion`
   * (defaults to `currentVersion`).  Convenience that combines the
   * downcast + frame-shape — exactly what `migratingAdapter` calls
   * from its `toJournal`.
   */
  toJournalAt(current: Current, writeVersion?: number): OutboundFrame {
    const version = writeVersion ?? this._currentVersion;
    return {
      manifest: this._manifest,
      version,
      payload: version === this._currentVersion ? current : this.downcast(current, version),
    };
  }
}
