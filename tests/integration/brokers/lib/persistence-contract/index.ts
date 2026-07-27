/**
 * The parameterized persistence contract (#390).
 *
 * `Journal`, `SnapshotStore` and `DurableStateStore` each have exactly one
 * scenario set, and every implementation runs against it — the fakes and
 * in-memory stores in the fast `bun test` pass, the real databases in the
 * Docker suites.  Adding a backend means writing a harness, not another
 * copy of the tests; fixing a behaviour means changing one scenario, and
 * every backend is re-checked against it.
 */
export { assert, assertEqual, expectThrows } from './assert.js';
export { durableStateContractScenarios } from './durable-state.js';
export { journalContractScenarios } from './journal.js';
export { snapshotContractScenarios } from './snapshot.js';
export {
  closeQuietly,
  type ContractScenario,
  type DurableStateHarness,
  type JournalCapabilities,
  type JournalHarness,
  type SnapshotCapabilities,
  type SnapshotHarness,
} from './types.js';
