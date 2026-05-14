/**
 * Object-storage persistence: snapshots in S3 (or filesystem, or MinIO).
 *
 * The same `registerObjectStoragePlugins(...)` call wires:
 *   - `ObjectStorageSnapshotStore` → registered against the
 *     `PersistenceExtension` snapshot-store registry (config picks it up).
 *   - `ObjectStorageDurableStateStore` → returned in the handles for
 *     callers that want it (this example doesn't, but see durable-state-kv.ts).
 *
 * Compression and encryption are configured here as **resolver
 * functions** so the same plugin instance can write some persistence
 * IDs as gzipped clear-text and others as zstd + AES-GCM — useful for
 * multi-tenant deployments.  See README.md "Object-storage persistence".
 *
 * The example uses the filesystem backend by default so it runs offline.
 * To target a real S3-compatible bucket, swap `kind: 'filesystem'` for
 * the `kind: 's3'` block at the bottom — credentials are read from the
 * standard AWS env vars (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).
 *
 *   bun run examples/persistence/s3-snapshot-bank-account.ts
 *
 * Pointing at MinIO:
 *   docker run --rm -p 9000:9000 minio/minio server /data
 *   ACTOR_TS_S3=minio bun run examples/persistence/s3-snapshot-bank-account.ts
 */
import { match, P } from 'ts-pattern';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActorSystem,
  InMemoryJournal,
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  PersistenceExtensionId,
  PersistentActor,
  Props,
  compressionByPrefix,
  everyNEvents,
  registerObjectStoragePlugins,
} from '../../src/index.js';
import type {
  CompressionConfig,
  EncryptionConfig,
  ObjectStorageBackendSpec,
} from '../../src/index.js';

type Cmd =
  | { kind: 'deposit'; amount: number }
  | { kind: 'withdraw'; amount: number }
  | { kind: 'balance' };
type Event = { kind: 'deposited' | 'withdrew'; amount: number };
type State = { balance: number };

class Account extends PersistentActor<Cmd, Event, State> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): State { return { balance: 0 }; }
  onEvent(s: State, e: Event): State {
    return e.kind === 'deposited'
      ? { balance: s.balance + e.amount }
      : { balance: s.balance - e.amount };
  }
  // Snapshot every 3 events so we can see the object-storage writes
  // happen even on a short script.
  snapshotPolicy() { return everyNEvents<State, Event>(3); }
  // Per-actor compression — overrides the plugin default.  Each actor
  // gets to pick its own algorithm without touching plugin registration.
  override compression(): CompressionConfig { return { algorithm: 'zstd' }; }
  // To enable client-side AES encryption per actor, return:
  //   override encryption(): EncryptionConfig {
  //     return { mode: 'client-aes256-gcm', masterKey: this.tenantKey() };
  //   }
  // Marker just to silence the unused-import lint for the type below.
  protected _enc(): EncryptionConfig | undefined { return undefined; }
  async onCommand(s: State, cmd: Cmd): Promise<void> {
    const reply = (msg: unknown): void => this.sender.forEach((sender) => sender.tell(msg));
    await match(cmd)
      .with({ kind: 'deposit', amount: P.number.gt(0) }, async (c) => {
        await this.persist({ kind: 'deposited', amount: c.amount },
          (st) => reply({ balance: st.balance }));
      })
      .with({ kind: 'withdraw' }, async (c) => {
        if (c.amount > s.balance) { reply(new Error('rejected')); return; }
        await this.persist({ kind: 'withdrew', amount: c.amount },
          (st) => reply({ balance: st.balance }));
      })
      .with({ kind: 'balance' }, async () => reply({ balance: s.balance }))
      .otherwise(async () => reply(new Error('rejected')));
  }
}

function pickBackend(): { spec: ObjectStorageBackendSpec; cleanup: () => void } {
  const mode = process.env.ACTOR_TS_S3;
  if (mode === 'minio') {
    return {
      spec: {
        kind: 's3',
        bucket: process.env.S3_BUCKET ?? 'actor-ts-example',
        region: 'us-east-1',
        endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
          secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
        },
      },
      cleanup: () => { /* MinIO bucket cleanup is up to the operator. */ },
    };
  }
  if (mode === 's3') {
    if (!process.env.S3_BUCKET) {
      throw new Error('ACTOR_TS_S3=s3 requires S3_BUCKET env var');
    }
    return {
      spec: {
        kind: 's3',
        bucket: process.env.S3_BUCKET,
        region: process.env.AWS_REGION ?? 'us-east-1',
        // No credentials → SDK default chain (env, profile, IAM role).
      },
      cleanup: () => { /* live bucket — never auto-clean. */ },
    };
  }
  // Default: ephemeral filesystem.
  const dir = mkdtempSync(join(tmpdir(), 'actor-ts-s3-example-'));
  return {
    spec: { kind: 'filesystem', dir },
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

async function main(): Promise<void> {
  const { spec, cleanup } = pickBackend();
  const journal = new InMemoryJournal();

  // --- first incarnation: record events + snapshots ---
  const sys1 = ActorSystem.create('bank-s3', {
    config: {
      'actor-ts': {
        persistence: {
          'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
        },
      },
    },
    persistence: { journal },
  });
  await registerObjectStoragePlugins(sys1.extension(PersistenceExtensionId), {
    backend: spec,
    prefix: 'env-prod/snapshots/',
    keepN: 2,
    compression: compressionByPrefix({
      default: { algorithm: 'gzip' },
      'large/': { algorithm: 'zstd' },
    }),
    // To enable client-side encryption uncomment + supply a 32-byte key:
    // encryption: { mode: 'client-aes256-gcm', masterKey: new Uint8Array(32).fill(0xab) },
  });

  const acct1 = sys1.spawn(Props.create(() => new Account('alice')), 'alice');
  for (const amount of [100, 50, 20, 30, 10, 5, 100]) {
    console.log('deposit', amount, '→', await acct1.ask({ kind: 'deposit', amount }, 500));
  }
  console.log('withdraw 60 →', await acct1.ask({ kind: 'withdraw', amount: 60 }, 500));
  console.log('balance     →', await acct1.ask({ kind: 'balance' }, 500));
  await sys1.terminate();

  // --- second incarnation: recover from the same journal + snapshot bucket ---
  const sys2 = ActorSystem.create('bank-s3-restart', {
    config: {
      'actor-ts': {
        persistence: {
          'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
        },
      },
    },
    persistence: { journal },
  });
  await registerObjectStoragePlugins(sys2.extension(PersistenceExtensionId), {
    backend: spec,
    prefix: 'env-prod/snapshots/',
  });
  const acct2 = sys2.spawn(Props.create(() => new Account('alice')), 'alice');
  console.log('after restart, balance →', await acct2.ask({ kind: 'balance' }, 500));
  await sys2.terminate();

  cleanup();
}

void main();
