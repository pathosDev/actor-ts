import { MigrationError } from './Envelope.js';
import type { StoredFrame } from './Adapter.js';

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
}
