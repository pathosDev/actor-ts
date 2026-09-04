import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cache } from '../../../src/cache/Cache.js';
import type { ObjectStorageBackend } from '../../../src/persistence/object-storage/ObjectStorageBackend.js';
import {
  CachedSnapshotStore,
  CachedSnapshotStoreOptions,
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
  DurableStateActor,
  DurableStateOptions,
  DynamoDbDurableStateStore,
  DynamoDbSnapshotStore,
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  MongoDurableStateStore,
  MongoSnapshotStore,
  ObjectStorageDurableStateStore,
  ObjectStorageSnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
  PostgresDurableStateStore,
  PostgresSnapshotStore,
  SqliteDurableStateStore,
  SqliteSnapshotStore,
  UnsupportedPersistenceOptionError,
  type CompressionConfig,
  type DurableStateRecord,
  type DurableStateStore,
  type EncryptionConfig,
  type IntegrityConfig,
  type PersistenceOptionSupport,
  type Snapshot,
  type SnapshotStore,
} from '../../../src/persistence/index.js';
import { unhonouredPersistenceOptions } from '../../../src/persistence/PersistenceCapabilities.js';
import { fromNullable, none, type Option } from '../../../src/util/Option.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/**
 * Conformance sweep over `persistenceOptionSupport` (#960) — the sibling of
 * `StorageLocalityDeclarations.test.ts`, and the same class of guard for the
 * same reason.
 *
 * The member is deliberately OPTIONAL, because absence has to mean "unknown":
 * a third-party store that genuinely encrypts would otherwise start throwing
 * on upgrade for having declared nothing.  The cost of that choice is a quiet
 * rot channel — an in-repo store added without a declaration compiles, passes
 * its own suite, and is silently exempt from the refusal.  This file closes
 * it in three parts: value assertions for what each family declares, a repo
 * scan that fails when a store class neither declares the member nor inherits
 * it, and the actor seam itself, where the declaration turns into a refusal.
 *
 * What is NOT here, on purpose: proof that a `false` declaration matches
 * behaviour.  That belongs to the contract suite, which runs it against every
 * shipped store (`persistence-contract/Snapshot.ts`,
 * `persistence-contract/DurableState.ts`), and the positive half already
 * exists as `object-storage/PerActorCompressionEncryption.test.ts`.
 */

const NONE_SUPPORTED: PersistenceOptionSupport = { encryption: false, compression: false, integrity: false };
const ALL_SUPPORTED: PersistenceOptionSupport = { encryption: true, compression: true, integrity: true };

/* --------------------------- shared fixtures ----------------------------- */

const MASTER_KEY = new Uint8Array(32).fill(0x11);
const INTEGRITY_KEY = new Uint8Array(32).fill(0x22);

const CLIENT_ENCRYPTION: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKey: MASTER_KEY,
  info: 'actor-ts/test/capabilities/v1',
};
const HMAC_INTEGRITY: IntegrityConfig = { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY };
const GZIP_COMPRESSION: CompressionConfig = { algorithm: 'gzip' };

const fakeCache = { get: async () => null, set: async () => {}, delete: async () => {} } as unknown as Cache;

const fakeBackend: ObjectStorageBackend = {
  async put() { return { etag: 'fixture' }; },
  async get() { return none; },
  async delete() {},
  async list() { return []; },
};

/* ---------------------------- the declarations --------------------------- */

describe('persistenceOptionSupport declarations', () => {
  test('the object-storage pair is the only family that acts on all three fields', () => {
    expect(new ObjectStorageSnapshotStore({ backend: fakeBackend }).persistenceOptionSupport)
      .toEqual(ALL_SUPPORTED);
    expect(new ObjectStorageDurableStateStore({ backend: fakeBackend }).persistenceOptionSupport)
      .toEqual(ALL_SUPPORTED);
  });

  test('every other shipped snapshot store declares none of the three', () => {
    // `PostgresSnapshotStore` stands in for the relational family, whose
    // declaration lives on `RelationalSnapshotStore`; the repo scan below
    // holds MariaDB, MSSQL, libSQL and D1 to the same inheritance.  It is
    // constructed with no pool on purpose — the pool opens lazily, so this
    // asserts a declaration without touching a database.
    expect(new PostgresSnapshotStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    // Standalone `implements SnapshotStore`: it shares no base with the
    // relational family, so the family declaration does not reach it.
    expect(new SqliteSnapshotStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    expect(new InMemorySnapshotStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    expect(new MongoSnapshotStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    expect(new DynamoDbSnapshotStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    expect(new CassandraSnapshotStore(CassandraSnapshotStoreOptions.create()).persistenceOptionSupport)
      .toEqual(NONE_SUPPORTED);
  });

  test('every other shipped durable-state store declares none of the three', () => {
    expect(new PostgresDurableStateStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    // Unlike the snapshot side, the SQLite durable-state store extends the
    // relational base and inherits the declaration rather than repeating it.
    expect(new SqliteDurableStateStore({ path: ':memory:' }).persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    expect(new InMemoryDurableStateStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    expect(new MongoDurableStateStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
    expect(new DynamoDbDurableStateStore().persistenceOptionSupport).toEqual(NONE_SUPPORTED);
  });

  /**
   * The decorator must have no opinion of its own.  A literal would be a lie
   * in both directions — `false` would refuse an actor whose object-storage
   * store can encrypt, `true` would wave one through over Postgres — and an
   * undefined inner store must stay undefined rather than be laundered into
   * a confident answer (#960, #782).
   */
  test('CachedSnapshotStore delegates its declaration to the store it wraps', () => {
    const cachedOptions = CachedSnapshotStoreOptions.create().withCache(fakeCache);
    const overPlaintext = new CachedSnapshotStore(new InMemorySnapshotStore(), cachedOptions);
    expect(overPlaintext.persistenceOptionSupport).toEqual(NONE_SUPPORTED);

    const overObjectStorage = new CachedSnapshotStore(
      new ObjectStorageSnapshotStore({ backend: fakeBackend }), cachedOptions,
    );
    expect(overObjectStorage.persistenceOptionSupport).toEqual(ALL_SUPPORTED);

    const undeclared = new CachedSnapshotStore(new UndeclaredSnapshotStore(), cachedOptions);
    expect(undeclared.persistenceOptionSupport).toBeUndefined();
  });
});

/* ------------------------------ the repo scan ---------------------------- */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const PERSISTENCE_ROOT = join(REPOSITORY_ROOT, 'src', 'persistence');

/** The directories that hold every snapshot / durable-state store implementation. */
const STORE_DIRECTORIES = ['snapshot-stores', 'durable-state-stores', 'relational'] as const;

/**
 * Bases that declare the member for their whole family.  `RelationalStore`
 * is deliberately NOT one of them: it is shared with `RelationalJournal`,
 * which implements a contract that carries no `PersistenceOptions` at all.
 */
const DECLARING_BASES = ['RelationalSnapshotStore', 'RelationalDurableStateStore'] as const;

/**
 * Same line-level comment stripping as `StorageLocalityDeclarations.test.ts`,
 * for the same reason in both directions: a `persistenceOptionSupport` named
 * only in prose must not satisfy the requirement, and an `implements
 * SnapshotStore` quoted in a doc block must not drag a non-store file in.
 */
function withoutCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

type ScannedStoreFile = {
  readonly path: string;
  readonly declares: boolean;
  readonly inheritsDeclaringBase: boolean;
};

function scanStoreFiles(): readonly ScannedStoreFile[] {
  const implementsContract = /implements (SnapshotStore|DurableStateStore)\b/;
  const extendsDeclaringBase = new RegExp(`extends (${DECLARING_BASES.join('|')})\\b`);
  const files: ScannedStoreFile[] = [];
  for (const directory of STORE_DIRECTORIES) {
    for (const entry of readdirSync(join(PERSISTENCE_ROOT, directory))) {
      if (!entry.endsWith('.ts')) continue;
      const source = withoutCommentLines(readFileSync(join(PERSISTENCE_ROOT, directory, entry), 'utf8'));
      const inheritsDeclaringBase = extendsDeclaringBase.test(source);
      if (!implementsContract.test(source) && !inheritsDeclaringBase) continue;
      files.push({
        path: `${directory}/${entry}`,
        declares: source.includes('persistenceOptionSupport'),
        inheritsDeclaringBase,
      });
    }
  }
  return files;
}

describe('persistenceOptionSupport — the repo half', () => {
  test('every in-repo store declares or inherits an option-support triple', () => {
    const storeFiles = scanStoreFiles();
    // Guard the guard first: the scan is two regexes over class-declaration
    // lines, and a refactor that reformatted them would empty the list and
    // make the absence assertion below pass by having nothing to check.
    expect(
      storeFiles.length,
      'The store scan found almost nothing under src/persistence. Either the '
      + 'directories moved or the class declarations no longer match the '
      + '`implements`/`extends` patterns.',
    ).toBeGreaterThan(20);
    expect(
      storeFiles.filter((file) => !file.inheritsDeclaringBase).length,
      'No store class implements a contract directly any more — every file '
      + 'matched as a subclass of a declaring base. That inverts the scan\'s '
      + 'assumptions; re-derive DECLARING_BASES.',
    ).toBeGreaterThan(5);

    const undeclared = storeFiles
      .filter((file) => !file.declares && !file.inheritsDeclaringBase)
      .map((file) => file.path);
    expect(
      undeclared,
      'These store classes neither declare `persistenceOptionSupport` nor '
      + 'extend a base that declares it for the family. An undeclared store '
      + 'is "unknown", so an actor that sets encryption() or integrity() '
      + 'against it is NOT refused and its data is written unprotected — '
      + 'fine for third-party code, silent rot for ours. Declare the triple '
      + 'on the class (or its family base), truthfully (#960).',
    ).toEqual([]);
  });
});

/* --------------------------- the request filter -------------------------- */

describe('unhonouredPersistenceOptions', () => {
  test('an undeclared store reports nothing — unknown is not evidence', () => {
    expect(unhonouredPersistenceOptions({ encryption: CLIENT_ENCRYPTION }, undefined)).toEqual([]);
  });

  test('no options at all reports nothing', () => {
    expect(unhonouredPersistenceOptions(undefined, NONE_SUPPORTED)).toEqual([]);
  });

  test('a store that acts on a field is not reported for it', () => {
    expect(unhonouredPersistenceOptions(
      { encryption: CLIENT_ENCRYPTION, integrity: HMAC_INTEGRITY, compression: GZIP_COMPRESSION },
      ALL_SUPPORTED,
    )).toEqual([]);
  });

  test('every effective directive a store cannot honour is reported', () => {
    expect(unhonouredPersistenceOptions(
      { encryption: CLIENT_ENCRYPTION, integrity: HMAC_INTEGRITY, compression: GZIP_COMPRESSION },
      NONE_SUPPORTED,
    ).slice().sort()).toEqual(['compression', 'encryption', 'integrity']);
  });

  /**
   * The one case that must stay silent even against a store that supports
   * nothing: "do not encrypt" is exactly what a store that cannot encrypt
   * does, so refusing an explicit opt-*out* would be the one shape of this
   * check nobody would expect.
   */
  test('a directive that asks for nothing is honoured by every store', () => {
    expect(unhonouredPersistenceOptions(
      { encryption: { mode: 'none' }, integrity: { mode: 'none' }, compression: { algorithm: 'none' } },
      NONE_SUPPORTED,
    )).toEqual([]);
  });
});

/* ------------------------------- the seam -------------------------------- */

type NoopCommand = { readonly kind: 'noop' };
type NoopEvent = { readonly kind: 'noop' };
type CountState = { readonly count: number };

/** Records what `preStart` refused, which is unreachable once the actor dies. */
class ProbeAccount extends PersistentActor<NoopCommand, NoopEvent, CountState> {
  readonly persistenceId = 'capability-probe';

  constructor(
    private readonly caught: Error[],
    private readonly hooks: {
      readonly encryption?: EncryptionConfig;
      readonly integrity?: IntegrityConfig;
      readonly compression?: CompressionConfig;
    },
    private readonly started: { value: boolean } = { value: false },
  ) { super(); }

  initialState(): CountState { return { count: 0 }; }
  onEvent(state: CountState, _event: NoopEvent): CountState { return state; }
  override compression(): CompressionConfig | undefined { return this.hooks.compression; }
  override encryption(): EncryptionConfig | undefined { return this.hooks.encryption; }
  override integrity(): IntegrityConfig | undefined { return this.hooks.integrity; }

  override async preStart(): Promise<void> {
    try {
      await super.preStart();
    } catch (e) {
      this.caught.push(e as Error);
      throw e;
    }
    this.started.value = true;
  }

  async onCommand(_state: CountState, _command: NoopCommand): Promise<void> { /* unreached */ }
}

/** A durable-state store that records every read, so "never reached" is observable. */
class RecordingDurableStateStore implements DurableStateStore {
  readonly loads: string[] = [];
  readonly persistenceOptionSupport: PersistenceOptionSupport = NONE_SUPPORTED;

  async upsert<S>(persistenceId: string, expectedRevision: number, state: S): Promise<DurableStateRecord<S>> {
    return { persistenceId, revision: expectedRevision + 1, state, timestamp: Date.now() };
  }

  async load<S>(persistenceId: string): Promise<Option<DurableStateRecord<S>>> {
    this.loads.push(persistenceId);
    return none;
  }

  async delete(): Promise<void> { /* nothing stored */ }
}

/**
 * Declares nothing at all — the third-party shape that must never be refused.
 * Written standalone rather than as a subclass of `InMemorySnapshotStore`:
 * the base declares the member as non-optional, so a subclass cannot widen it
 * back to `undefined`, which is itself a small proof that the in-tree stores
 * cannot drift into "unknown" by accident.
 */
class UndeclaredSnapshotStore implements SnapshotStore {
  private readonly saved = new Map<string, Snapshot<unknown>>();

  async save<S = unknown>(persistenceId: string, seq: number, state: S): Promise<Snapshot<S>> {
    const snapshot: Snapshot<S> = { persistenceId, sequenceNr: seq, state, timestamp: Date.now() };
    this.saved.set(persistenceId, snapshot);
    return snapshot;
  }

  async loadLatest<S = unknown>(persistenceId: string): Promise<Option<Snapshot<S>>> {
    return fromNullable(this.saved.get(persistenceId) as Snapshot<S> | undefined);
  }

  async loadBefore<S = unknown>(): Promise<Option<Snapshot<S>>> { return none; }

  async delete(): Promise<void> { this.saved.clear(); }
}

function loggingSystem(name: string): { system: ActorSystem; log: RecordingLogger } {
  const log = new RecordingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(log));
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(new InMemoryJournal());
  return { system, log };
}

type ProbeHooks = ConstructorParameters<typeof ProbeAccount>[1];

async function refusalFrom(
  name: string,
  snapshotStore: ConstructorParameters<typeof CachedSnapshotStore>[0],
  hooks: ProbeHooks,
): Promise<UnsupportedPersistenceOptionError> {
  const { system } = loggingSystem(name);
  system.extension(PersistenceExtensionId).setSnapshotStore(snapshotStore);
  const caught: Error[] = [];
  system.spawn(() => new ProbeAccount(caught, hooks), 'probe');
  try {
    await awaitCondition(() => caught.length > 0, { label: `${name}: preStart refused the actor` });
  } finally {
    await system.terminate();
  }
  expect(caught[0]).toBeInstanceOf(UnsupportedPersistenceOptionError);
  return caught[0] as UnsupportedPersistenceOptionError;
}

describe('PersistentActor — an unhonourable request is refused at start', () => {
  /**
   * Acceptance criterion 1 of #960, at the seam the triage chose: actor
   * start rather than the first write, because a durable-state actor reads
   * first (see the sibling suite below) and the two seams have to agree.
   *
   * `PostgresSnapshotStore` is constructed with no pool, and the refusal
   * lands before anything opens one — so this doubles as proof that the
   * check precedes any contact with the store at all.  If it did not, `pg`
   * would be reached for and the failure would arrive as a different error.
   */
  test('encryption() over a relational store throws, naming the store and the field', async () => {
    const error = await refusalFrom('refuse-encryption', new PostgresSnapshotStore(), {
      encryption: CLIENT_ENCRYPTION,
    });
    expect(error.field).toBe('encryption');
    expect(error.storeName).toBe('PostgresSnapshotStore');
    expect(error.message).toMatch(/does not implement encryption/);
  });

  test('integrity() over a store that cannot sign throws too', async () => {
    const error = await refusalFrom('refuse-integrity', new InMemorySnapshotStore(), {
      integrity: HMAC_INTEGRITY,
    });
    expect(error.field).toBe('integrity');
    expect(error.storeName).toBe('InMemorySnapshotStore');
  });

  test('a security control wins over a compression hint set in the same actor', async () => {
    const error = await refusalFrom('refuse-both', new InMemorySnapshotStore(), {
      encryption: CLIENT_ENCRYPTION,
      compression: GZIP_COMPRESSION,
    });
    expect(error.field).toBe('encryption');
  });

  /**
   * The half that must NOT throw.  Compression is a performance hint, and a
   * hard failure would make any system-wide compression default unusable the
   * moment one store in the deployment cannot compress — so the actor runs
   * and the operator gets one warning naming the store.
   */
  test('compression() warns once and lets the actor run', async () => {
    const { system, log } = loggingSystem('warn-compression');
    system.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());
    const caught: Error[] = [];
    const started = { value: false };
    system.spawn(() => new ProbeAccount(caught, { compression: GZIP_COMPRESSION }, started), 'probe');
    await awaitCondition(() => started.value, { label: 'the actor started despite the hint' });
    // A second actor over the same store must not repeat the warning.
    const secondStarted = { value: false };
    system.spawn(() => new ProbeAccount(caught, { compression: GZIP_COMPRESSION }, secondStarted), 'probe-2');
    await awaitCondition(() => secondStarted.value, { label: 'the second actor started too' });
    await system.terminate();

    expect(caught).toEqual([]);
    const warnings = log.records.filter(
      (record) => record.level === 'warn' && record.message.includes('does not implement compression'),
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.message).toMatch(/InMemorySnapshotStore/);
  });

  /**
   * `StorageLocality`'s rule, verbatim: a store that declared nothing must
   * never be misjudged by a default it did not choose.  A third-party store
   * that genuinely encrypts would otherwise start throwing on upgrade.
   */
  test('an undeclared store is unknown, and unknown never refuses', async () => {
    const { system, log } = loggingSystem('undeclared-store');
    system.extension(PersistenceExtensionId).setSnapshotStore(new UndeclaredSnapshotStore());
    const caught: Error[] = [];
    const started = { value: false };
    system.spawn(
      () => new ProbeAccount(caught, { encryption: CLIENT_ENCRYPTION, compression: GZIP_COMPRESSION }, started),
      'probe',
    );
    await awaitCondition(() => started.value, { label: 'the actor started against an undeclared store' });
    await system.terminate();
    expect(caught).toEqual([]);
    expect(log.records.filter((record) => record.message.includes('#960'))).toEqual([]);
  });

  /** `{ mode: 'none' }` is the documented way to say "deliberately unprotected". */
  test('an explicit opt-out is accepted by a store that supports nothing', async () => {
    const { system } = loggingSystem('opt-out');
    system.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());
    const caught: Error[] = [];
    const started = { value: false };
    system.spawn(
      () => new ProbeAccount(caught, { encryption: { mode: 'none' }, integrity: { mode: 'none' } }, started),
      'probe',
    );
    await awaitCondition(() => started.value, { label: 'the opt-out actor started' });
    await system.terminate();
    expect(caught).toEqual([]);
  });
});

/* ------------------------ the durable-state seam ------------------------- */

type SetCommand = { readonly kind: 'set'; readonly value: string };
type SettingState = { readonly value: string };

class ProbeSetting extends DurableStateActor<SetCommand, SettingState> {
  constructor(
    options: ConstructorParameters<typeof DurableStateActor<SetCommand, SettingState>>[0],
    private readonly caught: Error[],
    private readonly _encryption?: EncryptionConfig,
  ) { super(options); }

  protected override encryption(): EncryptionConfig | undefined { return this._encryption; }

  override async preStart(): Promise<void> {
    try {
      await super.preStart();
    } catch (e) {
      this.caught.push(e as Error);
      throw e;
    }
  }

  override async onCommand(command: SetCommand): Promise<void> { await this.persist({ value: command.value }); }
}

describe('DurableStateActor — the refusal precedes the load, not just the write', () => {
  /**
   * The trap this seam exists for: `preStart` *reads* before it ever writes,
   * so a check that only guarded `upsert` would still let the load hand the
   * actor a plaintext record it believes was ciphertext.  Proven by a store
   * that records every read — `loads` must stay empty.
   */
  test('encryption() over a store that cannot decrypt throws before load is called', async () => {
    const { system } = loggingSystem('durable-refuse');
    const store = new RecordingDurableStateStore();
    const options = DurableStateOptions.create<SettingState>()
      .withPersistenceId('capability-probe')
      .withStore(store)
      .withEmptyState(() => ({ value: '' }));
    const caught: Error[] = [];
    system.spawn(() => new ProbeSetting(options, caught, CLIENT_ENCRYPTION), 'setting');
    try {
      await awaitCondition(() => caught.length > 0, { label: 'preStart refused the durable-state actor' });
    } finally {
      await system.terminate();
    }
    expect(caught[0]).toBeInstanceOf(UnsupportedPersistenceOptionError);
    expect((caught[0] as UnsupportedPersistenceOptionError).field).toBe('encryption');
    expect(
      store.loads,
      'The refusal must land before preStart reads. A load that happened here '
      + 'returned a plaintext record to an actor that asked for ciphertext.',
    ).toEqual([]);
  });

  /** The relational half of acceptance criterion 4, on a real SQL store. */
  test('encryption() over a relational durable-state store throws, naming it', async () => {
    const { system } = loggingSystem('durable-refuse-sqlite');
    const options = DurableStateOptions.create<SettingState>()
      .withPersistenceId('capability-probe')
      .withStore(new SqliteDurableStateStore({ path: ':memory:' }))
      .withEmptyState(() => ({ value: '' }));
    const caught: Error[] = [];
    system.spawn(() => new ProbeSetting(options, caught, CLIENT_ENCRYPTION), 'setting');
    try {
      await awaitCondition(() => caught.length > 0, { label: 'preStart refused the SQLite-backed actor' });
    } finally {
      await system.terminate();
    }
    expect((caught[0] as UnsupportedPersistenceOptionError).storeName).toBe('SqliteDurableStateStore');
  });
});
