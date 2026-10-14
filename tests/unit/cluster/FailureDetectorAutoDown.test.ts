/**
 * #1426 — `actor-ts.cluster.failure-detector.auto-down`: whether the failure
 * detector may remove an unreachable peer on its own word when no downing
 * provider is configured.
 *
 * The switch and a provider are mutually exclusive.  Since #929 a configured
 * provider owns every removal and the detector only parks, so `auto-down = on`
 * beside one would be a switch that silently does nothing — while the operator
 * who wrote it meant the detector to remove.  `Cluster.join` refuses the pair,
 * whichever layer each half came from, before anything is bound.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions, type ClusterOptionsBuilder } from '../../../src/cluster/ClusterOptions.js';
import type { DowningProvider } from '../../../src/cluster/downing/index.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const SELF_HOST = '10.0.142.1';

const AUTO_DOWN_KEY = 'actor-ts.cluster.failure-detector.auto-down';
const ACTIVE_STRATEGY_KEY = 'actor-ts.cluster.split-brain-resolver.active-strategy';

/** A provider that is never asked anything here — its presence is the subject. */
const NEVER_DECIDES: DowningProvider = { decide: () => new Set<string>() };

let systems: ActorSystem[] = [];
let clusters: Cluster[] = [];

afterEach(async () => {
  for (const cluster of clusters) {
    try { await cluster.leave(); } catch { /* teardown is best-effort */ }
  }
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
  clusters = [];
  systems = [];
});

function quietSystem(systemName: string, config?: Config): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config !== undefined) systemOptions.withConfig(config);
  const system = ActorSystem.create(systemName, systemOptions);
  systems.push(system);
  return system;
}

/** Options for a one-node cluster on an in-memory transport — nothing is ever dialled. */
function lonelyNode(systemName: string, port: number): ClusterOptionsBuilder {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  return ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address));
}

/** The error `Cluster.join` threw, or `undefined` when it started a cluster. */
async function joinError(system: ActorSystem, options: ClusterOptions): Promise<unknown> {
  try {
    clusters.push(await Cluster.join(system, options));
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectRefusalNamingBoth(error: unknown): void {
  expect(error).toBeInstanceOf(OptionsError);
  const refusal = error as OptionsError;
  expect(refusal.field).toBe('failureDetectorAutoDown');
  // Both halves, by every name an operator may have used for them: the two
  // fields a caller sets in code and the two keys a config file sets.
  expect(refusal.message).toContain('failureDetectorAutoDown');
  expect(refusal.message).toContain('downing');
  expect(refusal.message).toContain(AUTO_DOWN_KEY);
  expect(refusal.message).toContain(ACTIVE_STRATEGY_KEY);
}

describe('auto-down beside a downing provider is refused at Cluster.join (#1426)', () => {
  test('in code: a provider and auto-down on', async () => {
    const system = quietSystem('auto-down-refused-code');
    const clusterOptions = lonelyNode('auto-down-refused-code', 9_421)
      .withDowning(NEVER_DECIDES)
      .withFailureDetectorAutoDown(true);

    expectRefusalNamingBoth(await joinError(system, clusterOptions));
  });

  test('in HOCON: a named strategy and auto-down = on', async () => {
    // Both halves from the file, which is where an operator meets them: the
    // validator sees the merged settings, so the strategy `readDowningFromConfig`
    // built counts as a configured provider exactly like `withDowning`.
    const config = Config.parseString(`
      ${ACTIVE_STRATEGY_KEY} = keep-majority
      ${AUTO_DOWN_KEY} = on
    `);
    const system = quietSystem('auto-down-refused-hocon', config);
    const clusterOptions = lonelyNode('auto-down-refused-hocon', 9_422);

    expectRefusalNamingBoth(await joinError(system, clusterOptions));
  });

  test('either half alone is accepted', async () => {
    // The refusal is about the pair: auto-down without a provider is the
    // documented opt-in, and a provider with auto-down off is the default.
    const withoutProvider = quietSystem('auto-down-alone');
    const autoDownOptions = lonelyNode('auto-down-alone', 9_423).withFailureDetectorAutoDown(true);
    expect(await joinError(withoutProvider, autoDownOptions)).toBeUndefined();

    const withProvider = quietSystem('auto-down-provider-alone');
    const providerOptions = lonelyNode('auto-down-provider-alone', 9_424)
      .withDowning(NEVER_DECIDES)
      .withFailureDetectorAutoDown(false);
    expect(await joinError(withProvider, providerOptions)).toBeUndefined();
  });
});
