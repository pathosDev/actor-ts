/**
 * The stub check — the reason `cassandra-driver` had to be declared somewhere
 * at all (#676).
 *
 * `src/persistence/journals/CassandraClient.ts` reaches the driver through a
 * hand-written structural type (`CassandraDriver` and `CassandraClientLike`),
 * because the library must not name an optional peer in an import specifier:
 * the build compile cannot resolve a package only this manifest declares, and
 * an exported type that imported one would emit that specifier into a
 * published `.d.ts` a consumer who skipped the peer cannot resolve.  The cost
 * is that `FakeCassandraClient` satisfies the stub *by construction*, so every
 * unit suite stays green no matter what upstream does to the real module.
 *
 * This is where that gets checked.  It is the same job
 * `tests/unit/ci/OptionalPeerModuleShapes.test.ts` does for the peers that live
 * in the ROOT manifest — and it lives here instead because the driver cannot
 * be a root devDependency: 4.9.0 hard-pins `adm-zip: ~0.5.10` and
 * GHSA-xcpc-8h2w-3j85 is fixed only in 0.6.0, so a root entry turns
 * `bun run lint:audit` red.
 *
 * Deliberately narrow: the destructured surface, the numeric constants the
 * options JSDoc tells users to pass, and the one CQL result convention the
 * append path decodes.  No adapter behaviour — the scenarios after this one
 * are that.
 */
import { keyspaceDdl } from '../../../../../src/persistence/journals/CassandraClient.js';
import { assert, assertEqual } from '../../lib/persistence-contract/Assert.js';
import type { BrokerScenario } from '../../lib/Scenario.js';
import {
  connectionFor,
  makeClient,
  CONSISTENCY_LOCAL_QUORUM,
  SERIAL_CONSISTENCY_LOCAL_SERIAL,
  type CassandraContext,
} from '../Runner.js';

/**
 * The subset of the real module this scenario reads.  Written out rather than
 * imported from the driver's own types because the point is to check what is
 * *actually there* at runtime, not to restate what its `.d.ts` claims.
 */
type DriverModuleShape = {
  Client?: unknown;
  types?: { consistencies?: Record<string, unknown> };
};

export const scenario: BrokerScenario<CassandraContext> = {
  name: 'cassandra-driver still has the shape CassandraClient.ts destructures',
  async run(context) {
    // A literal specifier, which is correct HERE and only here: this tree
    // resolves against tests/integration/brokers/package.json, which is why
    // `tests/unit/ci/OptionalPeerDeclarations.test.ts` excludes it from the
    // scan that would otherwise demand a root devDependency for it.
    const driver = await import('cassandra-driver') as unknown as DriverModuleShape;

    // 1. `createCassandraClient` does `new driver.Client(options)`.  A renamed
    //    or moved export breaks on first connect with every fake-backed suite
    //    still green — the exact failure this whole file exists to prevent.
    assertEqual(
      typeof driver.Client,
      'function',
      'createCassandraClient constructs `new driver.Client(options)`',
    );

    // 2. `types.consistencies` — the numeric values the Cassandra options
    //    JSDoc tells users to pass, and that this suite transcribes because
    //    `src/` cannot import the enum.  Two copies of a number is exactly the
    //    thing that drifts, so they are compared rather than trusted.
    const consistencies = driver.types?.consistencies;
    assert(consistencies !== undefined, 'the driver still exports `types.consistencies`');
    assertEqual(
      consistencies['localQuorum'],
      CONSISTENCY_LOCAL_QUORUM,
      'localQuorum is the value CassandraConnection.consistency documents',
    );
    assertEqual(
      consistencies['localSerial'],
      SERIAL_CONSISTENCY_LOCAL_SERIAL,
      'localSerial is the value CassandraJournalOptions.serialConsistency documents',
    );

    // 3. The four members of `CassandraClientLike`, on a real instance built
    //    the way `createCassandraClient` builds it — so the option bag it
    //    assembles (`contactPoints`, `localDataCenter`, `protocolOptions.port`)
    //    is accepted by the real constructor rather than only by the fake.
    const client = await makeClient(context);
    try {
      for (const member of ['connect', 'shutdown', 'execute', 'batch'] as const) {
        assertEqual(
          typeof (client as unknown as Record<string, unknown>)[member],
          'function',
          `CassandraClientLike.${member} exists on the real client`,
        );
      }
      await client.connect();

      // 4. `execute` resolves to something with `rows` as an array of plain
      //    records.  `CassandraRowResult` is the whole read contract; every
      //    store reads `response.rows[0]` and indexes it by column name.
      const version = await client.execute(
        'SELECT release_version FROM system.local',
        [],
        { prepare: true, consistency: CONSISTENCY_LOCAL_QUORUM },
      );
      assert(Array.isArray(version.rows), 'execute resolves to { rows: [...] }');
      assertEqual(version.rows.length, 1, 'system.local holds exactly one row');
      assert(
        typeof version.rows[0]!['release_version'] === 'string',
        'a row is indexable by column name',
      );

      // 5. The `[applied]` marker.  This is the highest-value assertion in the
      //    file: `CassandraJournal.executeConditional` reads the LWT outcome
      //    out of `row['[applied]']` — a driver-side column-name convention,
      //    not part of CQL — and throws loudly when it is missing rather than
      //    assuming the write applied.  A fake returns whatever it was told
      //    to, so nothing but a real Paxos round can confirm the key.
      const probeTable = `${context.keyspace}.driver_shape_probe`;
      // Through the library's own `keyspaceDdl()` rather than a second
      // hand-written `CREATE KEYSPACE`: this scenario runs first, so whichever
      // spelling it used would be the one the whole suite's keyspace ends up
      // with, and a replication clause that disagreed with the stores' would
      // silently decide what LOCAL_QUORUM means for every scenario after it.
      // It also puts the NetworkTopologyStrategy branch of that helper — and
      // its data-center-name escaping — in front of a real server.
      await client.execute(keyspaceDdl(connectionFor(context)));
      await client.execute(
        `CREATE TABLE IF NOT EXISTS ${probeTable} ( id text PRIMARY KEY, claimed bigint )`,
      );
      const key = context.pid('driver-shape');
      const firstClaim = await client.execute(
        `INSERT INTO ${probeTable} (id, claimed) VALUES (?, ?) IF NOT EXISTS`,
        [key, 1],
        { prepare: true, serialConsistency: SERIAL_CONSISTENCY_LOCAL_SERIAL },
      );
      assertEqual(
        firstClaim.rows[0]?.['[applied]'],
        true,
        'a winning LWT reports `[applied]: true` — the key executeConditional reads',
      );
      const losingClaim = await client.execute(
        `INSERT INTO ${probeTable} (id, claimed) VALUES (?, ?) IF NOT EXISTS`,
        [key, 2],
        { prepare: true, serialConsistency: SERIAL_CONSISTENCY_LOCAL_SERIAL },
      );
      assertEqual(
        losingClaim.rows[0]?.['[applied]'],
        false,
        'a losing LWT reports `[applied]: false` rather than throwing',
      );
      // And that the row it hands back carries the CURRENT column values, which
      // is what lets a losing append report an accurate `actualSeq` without a
      // second read.
      assertEqual(
        Number(losingClaim.rows[0]?.['claimed']),
        1,
        'a rejected LWT returns the row as it actually stands',
      );

      // 6. `batch` accepts the `{ query, params }` shape the append path
      //    builds, unlogged, in one call.  The stub types the return as
      //    `Promise<void>`; the driver resolves a ResultSet, which the journal
      //    discards — so this asserts the CALL, not the value.
      await client.batch(
        [
          { query: `INSERT INTO ${probeTable} (id, claimed) VALUES (?, ?)`, params: [`${key}:a`, 1] },
          { query: `INSERT INTO ${probeTable} (id, claimed) VALUES (?, ?)`, params: [`${key}:b`, 2] },
        ],
        { prepare: true, logged: false, consistency: CONSISTENCY_LOCAL_QUORUM },
      );
      const batched = await client.execute(
        `SELECT id FROM ${probeTable} WHERE id IN (?, ?)`,
        [`${key}:a`, `${key}:b`],
        { prepare: true },
      );
      assertEqual(batched.rows.length, 2, 'both statements of an unlogged batch landed');
    } finally {
      await client.shutdown();
    }
  },
};
