import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../../src/index.js';
import {
  BrokerActor,
  type BrokerCommonOptionsType,
  type RetiredLeaves,
} from '../../../../src/io/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { createTestActorSystem } from '../../../util/TestActorSystem.js';

/**
 * `RetiredLeaves` is reachable from the `actor-ts/io` door, beside the
 * `BrokerActor` whose `retiredLeaves()` hook returns it (#1443).
 *
 * The hook is how a broker written outside this package refuses the old
 * spelling of one of its own leaves after renaming it, and an override has to
 * name the hook's return type — which lived in `config/RetiredKeys.ts` and on
 * no barrel, so it could not.  A type-only export is erased at runtime, which
 * leaves `tests/unit/ExportSurface.test.ts` blind to it: what checks it is the
 * import above under `bun run typecheck:dev`, and the assertion below, which
 * stops compiling if the door hands out a type other than the one the hook
 * returns.
 */

/** `true` exactly when `A` and `B` are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Compiles only for `true`. */
type Assert<Condition extends true> = Condition;

export type RetiredLeavesIsWhatTheHookReturns = Assert<
  Equals<RetiredLeaves, ReturnType<BrokerActor<BrokerCommonOptionsType>['retiredLeaves']>>
>;

/** An application's own block, outside `actor-ts.io.broker`. */
const LEDGER_ROOT = 'acme.messaging.ledger';

/** The application renamed its `ledgerName` leaf to `ledger-name`. */
const RETIRED_LEDGER_LEAVES: RetiredLeaves = { ledgerName: 'ledger-name' };

interface LedgerOptions extends BrokerCommonOptionsType {
  readonly ledgerName?: string;
}

/** The broker under test never receives anything; the type exists to name it. */
type NoopCommand = { readonly kind: 'noop' };

/** How `preStart` ended, recorded by the broker itself. */
type PreStartOutcome = { settled: boolean; failure: unknown; ledgerName?: string };

/** A broker as an application would write one, from the package's doors alone. */
class LedgerBroker extends BrokerActor<LedgerOptions, NoopCommand, string> {
  constructor(private readonly outcome: PreStartOutcome) { super({}); }

  protected configKey(): string { return LEDGER_ROOT; }
  protected builtInDefaultOptions(): Partial<LedgerOptions> { return {}; }
  protected readOptionsFromConfig(config: Config): Partial<LedgerOptions> {
    const path = `${LEDGER_ROOT}.ledger-name`;
    return config.hasPath(path) ? { ledgerName: config.getString(path) } : {};
  }
  protected override retiredLeaves(): RetiredLeaves { return RETIRED_LEDGER_LEAVES; }
  protected requiredOptions(): ReadonlyArray<keyof LedgerOptions> { return []; }
  protected endpointLabel(): string { return 'ledger://local'; }
  protected async connectImplementation(): Promise<void> { /* nothing to open */ }
  protected async disconnectImplementation(): Promise<void> { /* nothing to close */ }
  protected async dispatchOutgoing(): Promise<void> { /* never sends */ }
  protected onCommand(): void { /* never receives */ }

  override async preStart(): Promise<void> {
    try {
      await super.preStart();
      if (this.options.ledgerName !== undefined) this.outcome.ledgerName = this.options.ledgerName;
    } catch (e) {
      this.outcome.failure = e;
    } finally {
      this.outcome.settled = true;
    }
  }
}

/** Start a `LedgerBroker` under `hocon` and report how its `preStart` ended. */
async function startLedger(hocon: string): Promise<PreStartOutcome> {
  const system = createTestActorSystem({ name: 'retired-leaves-door', config: Config.parseString(hocon) });
  try {
    const outcome: PreStartOutcome = { settled: false, failure: null };
    system.spawnAnonymous(() => new LedgerBroker(outcome));
    await awaitCondition(() => outcome.settled, { timeoutMs: 4_000, label: "the ledger broker's preStart settled" });
    return outcome;
  } finally {
    await system.terminate();
  }
}

describe('RetiredLeaves on the actor-ts/io door', () => {
  test('an override typed with it refuses the retired spelling at start, naming both paths', async () => {
    const outcome = await startLedger(`${LEDGER_ROOT} { ledgerName = "orders" }`);
    expect(outcome.failure).toBeInstanceOf(ConfigError);
    expect((outcome.failure as ConfigError).message)
      .toContain(`${LEDGER_ROOT}.ledgerName has been renamed to ${LEDGER_ROOT}.ledger-name`);
  });

  test('and reads the spelling that replaced it', async () => {
    const outcome = await startLedger(`${LEDGER_ROOT} { ledger-name = "orders" }`);
    expect(outcome.failure).toBeNull();
    expect(outcome.ledgerName).toBe('orders');
  });
});
