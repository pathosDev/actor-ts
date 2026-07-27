import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  D1DurableStateStore,
  D1DurableStateStoreOptions,
  D1Journal,
  D1JournalOptions,
  D1RequestError,
  D1SnapshotStore,
  D1SnapshotStoreOptions,
  D1_DURABLE_STATE_PLUGIN_ID,
  D1_JOURNAL_PLUGIN_ID,
  D1_SNAPSHOT_PLUGIN_ID,
  PersistenceExtensionId,
  RegisterD1PluginsOptions,
  buildD1Client,
  registerD1Plugins,
} from '../../../../src/persistence/index.js';
import { FakeD1Client } from './FakeD1Client.js';

/**
 * Cloudflare D1-specific behaviour (#438).  The three storage contracts are
 * covered by the shared suite in `PersistenceContract.test.ts`, which the D1 trio
 * is registered into.
 *
 * This file leans hardest on the **REST envelope**, because that is the one part
 * of the D1 path with no live-service coverage anywhere: D1 has no emulator that
 * fits a container suite, so there is no Docker suite for it.  The SQL underneath
 * is `sqliteDialect`'s and is already exercised against a real SQLite by
 * `SqliteJournal`'s tests — the transport is what needs pinning here, and it is
 * pinned against a stubbed `fetch` rather than a hand-written double.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replace `fetch` with a recorder that answers with the given body/status. */
function stubFetch(
  reply: { status?: number; body: unknown },
): { readonly calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(payload, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

const credentials = { accountId: 'acct', databaseId: 'db-uuid', apiToken: 'token' };

describe('buildD1Client — the REST envelope', () => {
  test('posts sql + params to the account/database endpoint with a bearer token', async () => {
    const stub = stubFetch({ body: { success: true, result: [{ success: true, results: [{ hi: 3 }], meta: { changes: 0 } }] } });
    const client = buildD1Client(credentials);
    const result = await client.query('SELECT ? AS hi', [3]);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url)
      .toBe('https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-uuid/query');
    expect(stub.calls[0]!.init.method).toBe('POST');
    const headers = stub.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token');
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ sql: 'SELECT ? AS hi', params: [3] });
    expect(result.rows).toEqual([{ hi: 3 }]);
  });

  test('a rejected statement arrives as HTTP 200 with success:false and must throw', async () => {
    // This is the trap the envelope handling exists for: D1 answers a failed
    // statement with a 200.  Trusting the status code would turn a constraint
    // violation into an empty result set, and the journal's concurrency backstop
    // would never fire.
    stubFetch({
      status: 200,
      body: { success: false, errors: [{ code: 7500, message: 'D1_ERROR: UNIQUE constraint failed: events.persistence_id' }] },
    });
    const client = buildD1Client(credentials);
    const failure = client.query('INSERT INTO events VALUES (?)', ['x']);
    await expect(failure).rejects.toBeInstanceOf(D1RequestError);
    // The message has to survive, because the SQLite dialect classifies a
    // duplicate key by text for this transport.
    await expect(failure).rejects.toThrow(/UNIQUE constraint failed/);
  });

  test('a per-statement success:false also throws', async () => {
    stubFetch({ body: { success: true, result: [{ success: false, results: [] }] } });
    const client = buildD1Client(credentials);
    await expect(client.query('SELECT 1', [])).rejects.toBeInstanceOf(D1RequestError);
  });

  test('meta.changes becomes the affected-row count', async () => {
    stubFetch({ body: { success: true, result: [{ success: true, results: [], meta: { changes: 4 } }] } });
    const client = buildD1Client(credentials);
    expect((await client.query('DELETE FROM events', [])).changes).toBe(4);
  });

  test('a non-2xx surfaces the response body, not just the status', async () => {
    // An expired token and a malformed statement are indistinguishable from the
    // status code alone.
    stubFetch({ status: 403, body: { errors: [{ message: 'Authentication error' }] } });
    const client = buildD1Client(credentials);
    await expect(client.query('SELECT 1', [])).rejects.toThrow(/HTTP 403.*Authentication error/s);
  });

  test('a custom baseUrl is honoured and trailing slashes are tolerated', async () => {
    const stub = stubFetch({ body: { success: true, result: [{ success: true, results: [] }] } });
    const client = buildD1Client({ ...credentials, baseUrl: 'http://localhost:8787/v4/' });
    await client.query('SELECT 1', []);
    expect(stub.calls[0]!.url).toBe('http://localhost:8787/v4/accounts/acct/d1/database/db-uuid/query');
  });

  test('incomplete credentials fail at build time with all three named', async () => {
    expect(() => buildD1Client({ accountId: 'acct' }))
      .toThrow(/accountId.*databaseId.*apiToken/s);
  });
});

describe('D1Journal — SQLite schema compatibility', () => {
  test('emits the same statements as the local SQLite and libSQL backends', async () => {
    const client = new FakeD1Client();
    const journal = new D1Journal(D1JournalOptions.create().withClient(client));
    await journal.append('account-1', ['created'], 0, ['ledger']);
    await journal.delete('account-1', 1);
    const issued = client.log.join('\n');
    // Sharing `sqliteDialect` is what lets a database move between D1, libSQL and
    // a local file without a migration.
    expect(issued).toContain('INSERT OR IGNORE INTO events_tags');
    expect(issued).toContain('sequence_nr INTEGER NOT NULL');
    expect(issued).toContain('MAX(deleted_to, excluded.deleted_to)');
    expect(issued).not.toContain('$1');
    expect(issued).not.toContain('GREATEST');
    expect(issued).not.toContain('BIGINT');
    await journal.close();
  });

  test('a racing writer is rejected through the primary key, not a transaction', async () => {
    // D1's REST API has no BEGIN, so this is the only thing standing between two
    // writers — worth asserting explicitly rather than trusting the contract run.
    const client = new FakeD1Client();
    const first = new D1Journal(D1JournalOptions.create().withClient(client));
    const second = new D1Journal(D1JournalOptions.create().withClient(client));
    await first.append('account-1', ['a'], 0);
    const racing = await Promise.allSettled([
      first.append('account-1', ['b'], 1),
      second.append('account-1', ['c'], 1),
    ]);
    expect(racing.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const loser = racing.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect((loser.reason as Error).name).toBe('JournalConcurrencyError');
    expect(await first.highestSeq('account-1')).toBe(2);
    await first.close();
    await second.close();
  });
});

describe('D1* option validation', () => {
  test('rejects partial credentials — the forgotten-env-var case', () => {
    const partial = D1JournalOptions.create()
      .withAccountId('acct')
      .withDatabaseId('db-uuid');
    expect(() => new D1Journal(partial)).toThrow(/must all be set together/);
    // All three, or a client, is fine.
    expect(() => new D1Journal(D1JournalOptions.create()
      .withAccountId('acct').withDatabaseId('db').withApiToken('t'))).not.toThrow();
    expect(() => new D1Journal(D1JournalOptions.create().withClient(new FakeD1Client()))).not.toThrow();
  });

  test('rejects an empty credential', () => {
    expect(() => new D1Journal(D1JournalOptions.create()
      .withAccountId('acct').withDatabaseId('db').withApiToken(''))).toThrow(/apiToken/);
  });

  test('rejects a baseUrl that is not an http(s) URL', () => {
    // `new URL('api.example.com:443')` succeeds — it reads the host as a scheme —
    // so the protocol is checked explicitly.
    for (const baseUrl of ['api.example.com:443', 'ftp://example.com', 'nonsense']) {
      expect(() => new D1Journal(D1JournalOptions.create().withClient(new FakeD1Client()).withBaseUrl(baseUrl)))
        .toThrow(/baseUrl must be a valid http\(s\) URL/);
    }
  });

  test('rejects an unsafe table name', () => {
    // Table names are interpolated into DDL/DML, so they are guarded (#6).
    expect(() => new D1Journal(D1JournalOptions.create()
      .withClient(new FakeD1Client()).withEventsTable('events; DROP TABLE x'))).toThrow(/identifier/);
  });

  test('rejects a fractional keepN but accepts 0 as keep-all', () => {
    const fractional = D1SnapshotStoreOptions.create().withClient(new FakeD1Client()).withKeepN(2.5);
    expect(() => new D1SnapshotStore(fractional)).toThrow(/keepN/);
    const keepAll = D1SnapshotStoreOptions.create().withClient(new FakeD1Client()).withKeepN(0);
    expect(() => new D1SnapshotStore(keepAll)).not.toThrow();
  });

  test('a store without credentials or a client fails only when it is first used', async () => {
    const journal = new D1Journal();
    expect(journal.highestSeq('account-1')).rejects.toThrow(/accountId.*databaseId.*apiToken/s);
  });
});

describe('D1* transport ownership', () => {
  test('an injected transport is left open — the caller shares and closes it', async () => {
    const client = new FakeD1Client();
    const journal = new D1Journal(D1JournalOptions.create().withClient(client));
    const snapshots = new D1SnapshotStore(D1SnapshotStoreOptions.create().withClient(client));
    const state = new D1DurableStateStore(D1DurableStateStoreOptions.create().withClient(client));
    await journal.append('account-1', ['a'], 0);
    await snapshots.save('account-1', 1, { v: 1 });
    await state.upsert('account-1', 0, { v: 1 });

    await journal.close();
    await snapshots.close();
    await state.close();

    expect(client.closed).toBe(false);
  });
});

describe('registerD1Plugins', () => {
  /**
   * Boots a system whose config names the D1 plug-ins, which is how the extension
   * selects them — `registerD1Plugins` only populates the factories (the two-step
   * registration #386 is meant to collapse).
   */
  function bootSystem(): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: { plugin: D1_JOURNAL_PLUGIN_ID },
            'snapshot-store': { plugin: D1_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    return ActorSystem.create('d1-plugins', systemOptions);
  }

  test('a shared transport reaches all three stores', async () => {
    const system = bootSystem();
    try {
      const client = new FakeD1Client();
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterD1PluginsOptions.create().withClient(client);
      const handles = registerD1Plugins(persistence, pluginOptions);

      expect(persistence.journal).toBeInstanceOf(D1Journal);
      expect(persistence.snapshotStore).toBeInstanceOf(D1SnapshotStore);
      expect(handles.durableStateStore).toBeInstanceOf(D1DurableStateStore);

      await persistence.journal.append('account-1', ['a'], 0);
      await persistence.snapshotStore.save('account-1', 1, { v: 1 });
      await handles.durableStateStore.upsert('account-1', 0, { v: 1 });
      expect(client.log.some((sql) => sql.startsWith('INSERT INTO events('))).toBe(true);
      expect(client.log.some((sql) => sql.startsWith('INSERT INTO snapshots('))).toBe(true);
      expect(client.log.some((sql) => sql.startsWith('INSERT INTO durable_state('))).toBe(true);
      expect(D1_DURABLE_STATE_PLUGIN_ID).toBe('actor-ts.persistence.durable-state.cloudflare-d1');
    } finally {
      await system.terminate();
    }
  });

  test('a leaf keeps its own table name while inheriting the shared credentials', async () => {
    const system = bootSystem();
    try {
      const client = new FakeD1Client();
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = D1JournalOptions.create().withEventsTable('ledger_events');
      const pluginOptions = RegisterD1PluginsOptions.create()
        .withClient(client)
        .withJournal(journalOptions);
      registerD1Plugins(persistence, pluginOptions);

      await persistence.journal.append('account-1', ['a'], 0);
      expect(client.log.some((sql) => sql.includes('INSERT INTO ledger_events('))).toBe(true);
    } finally {
      await system.terminate();
    }
  });
});
