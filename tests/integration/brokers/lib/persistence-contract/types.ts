/**
 * Harness types for the parameterized persistence contract (#390).
 *
 * One scenario set is shared by two very different callers:
 *
 *   - the fast `bun test` pass, where each backend is driven by an
 *     in-process fake driver (`FakePgPool`, `FakeMariaDbPool`, …), and
 *   - the live Docker suites, where the same scenarios run against a real
 *     database container.
 *
 * The harness is the seam between them: it knows how to *build* a store and
 * how to *namespace* persistence ids, and nothing else.  `make()` returns a
 * fresh instance on every call and the scenario closes what it made, so
 * scenarios never share mutable store state — the property that lets the
 * identical code run against a throwaway fake and a persistent database.
 */
import type { DurableStateStore } from '../../../../../src/persistence/DurableStateStore.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import type { SnapshotStore } from '../../../../../src/persistence/SnapshotStore.js';

/** A single contract scenario, parameterized over its harness type. */
export type ContractScenario<Harness> = {
  readonly name: string;
  /**
   * Return a human-readable reason to skip, or `null` to run.  Used for
   * genuine capability gaps (a store without a configurable `keepN`), never
   * to paper over a divergence that ought to be fixed.
   */
  skip?(harness: Harness): string | null;
  run(harness: Harness): Promise<void>;
};

/** Shared harness surface — every store family namespaces ids the same way. */
type HarnessBase = {
  /** Short label used in test names ("InMemory", "Postgres", …). */
  readonly label: string;
  /**
   * Namespace a persistence id.  Live suites run against a database that may
   * already hold rows from a previous run, so each scenario works on ids
   * derived from its own name; the in-process fakes start empty and the
   * namespacing is simply inert.
   */
  pid(name: string): string;
};

export type JournalCapabilities = {
  /** Journal round-trips `tags` on append/read.  Default `true`. */
  readonly tags?: boolean;
};

export type JournalHarness = HarnessBase & {
  /** Build a fresh journal.  The scenario closes it. */
  make(): Promise<Journal>;
  readonly capabilities?: JournalCapabilities;
};

export type SnapshotCapabilities = {
  /**
   * `'configurable'` — the store honours a `keepN` prune bound, so the
   * prune and keep-all scenarios run.  `'none'` — the store keeps every
   * snapshot (the in-memory reference store), and they are skipped.
   */
  readonly keepN?: 'configurable' | 'none';
};

export type SnapshotHarness = HarnessBase & {
  /**
   * Build a fresh snapshot store.  `keepN` is honoured by stores whose
   * capabilities declare `keepN: 'configurable'`; when omitted the store's
   * own default applies.
   */
  make(keepN?: number): Promise<SnapshotStore>;
  readonly capabilities?: SnapshotCapabilities;
};

export type DurableStateHarness = HarnessBase & {
  /** Build a fresh durable-state store.  The scenario closes it if it can. */
  make(): Promise<DurableStateStore>;
};

/** `close()` is optional across the three contracts — call it uniformly. */
export async function closeQuietly(store: unknown): Promise<void> {
  const closable = store as { close?: () => Promise<void> };
  if (typeof closable.close === 'function') await closable.close();
}
