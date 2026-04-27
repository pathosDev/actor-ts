import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import {
  DurableStateActor,
  everyNEvents,
  InMemoryJournal,
  PersistenceExtensionId,
  PersistentActor,
  type CompressionConfig,
  type EncryptionConfig,
} from '../../../../src/persistence/index.js';
import { FilesystemObjectStorageBackend } from '../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { ObjectStorageSnapshotStore } from '../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageDurableStateStore } from '../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import type { Actor as ActorBase } from '../../../../src/Actor.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

let dir: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-per-actor-'));
  backend = new FilesystemObjectStorageBackend({ dir });
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/* ----------------------- PersistentActor hooks --------------------------- */

type Cmd = { kind: 'inc' } | { kind: 'state' };
type Event = { kind: 'incremented' };
type State = { count: number };

class CountingActor extends PersistentActor<Cmd, Event, State> {
  constructor(
    readonly persistenceId: string,
    private readonly _compression?: CompressionConfig,
    private readonly _encryption?: EncryptionConfig,
  ) { super(); }
  initialState(): State { return { count: 0 }; }
  override compression(): CompressionConfig | undefined { return this._compression; }
  override encryption(): EncryptionConfig | undefined { return this._encryption; }
  override snapshotPolicy() { return everyNEvents<State, Event>(1); }
  onEvent(s: State, _e: Event): State { return { count: s.count + 1 }; }
  async onCommand(_s: State, cmd: Cmd): Promise<void> {
    if (cmd.kind === 'inc') {
      await this.persist({ kind: 'incremented' }, () => { /* no reply */ });
    }
  }
}

describe('PersistentActor — actor-level compression hook', () => {
  test('actor-level compression overrides plugin default', async () => {
    // Spy on backend.put to capture the contentEncoding header per save.
    const seen: string[] = [];
    const wrapped = wrapPut(backend, (key, opts) => seen.push(opts?.contentEncoding ?? 'none'));

    // Plugin default = gzip; actor sets zstd → save MUST land as zstd.
    const snapshots = new ObjectStorageSnapshotStore({
      backend: wrapped,
      compression: { algorithm: 'gzip' },
    });
    const sys = ActorSystem.create('per-actor-comp', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys.extension(PersistenceExtensionId).setJournal(new InMemoryJournal());
    sys.extension(PersistenceExtensionId).setSnapshotStore(snapshots);

    const ref = sys.actorOf(Props.create(() => new CountingActor('a', { algorithm: 'zstd' })), 'a');
    ref.tell({ kind: 'inc' });
    await sleep(40);

    expect(seen.length).toBeGreaterThan(0);
    for (const enc of seen) expect(enc).toBe('zstd');
    await sys.terminate();
  });

  test('without actor hook, plugin compression default is used', async () => {
    const seen: string[] = [];
    const wrapped = wrapPut(backend, (key, opts) => seen.push(opts?.contentEncoding ?? 'none'));
    const snapshots = new ObjectStorageSnapshotStore({
      backend: wrapped,
      compression: { algorithm: 'gzip' },
    });
    const sys = ActorSystem.create('per-actor-fallback', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys.extension(PersistenceExtensionId).setJournal(new InMemoryJournal());
    sys.extension(PersistenceExtensionId).setSnapshotStore(snapshots);

    // Actor without hooks → plugin default applies.
    const ref = sys.actorOf(Props.create(() => new CountingActor('a')), 'a');
    ref.tell({ kind: 'inc' });
    await sleep(40);

    expect(seen.length).toBeGreaterThan(0);
    for (const enc of seen) expect(enc).toBe('gzip');
    await sys.terminate();
  });
});

describe('PersistentActor — actor-level encryption hook', () => {
  test('client-side AES round-trip via actor hooks (no plugin config)', async () => {
    const masterKey = new Uint8Array(32).fill(0xab);
    const enc: EncryptionConfig = { mode: 'client-aes256-gcm', masterKey };
    // Plugin has neither compression nor encryption set — purely actor-driven.
    const snapshots = new ObjectStorageSnapshotStore({ backend });

    const sys = ActorSystem.create('actor-aes', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys.extension(PersistenceExtensionId).setJournal(new InMemoryJournal());
    sys.extension(PersistenceExtensionId).setSnapshotStore(snapshots);

    const ref = sys.actorOf(Props.create(() => new CountingActor('a', { algorithm: 'none' }, enc)), 'a');
    ref.tell({ kind: 'inc' });
    ref.tell({ kind: 'inc' });
    await sleep(40);
    await sys.terminate();

    // Inspect raw bytes — plaintext "incremented" must NOT appear.
    const items = await backend.list({ prefix: 'a/' });
    expect(items.length).toBeGreaterThan(0);
    const fetched = await backend.get(items[items.length - 1]!.key);
    expect(fetched.isSome()).toBe(true);
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(fetched.toNullable()!.body);
    expect(raw.includes('count')).toBe(false);
    expect(raw.includes('incremented')).toBe(false);

    // Restart with the same hook and verify recovery decrypts state correctly.
    const sys2 = ActorSystem.create('actor-aes-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys2.extension(PersistenceExtensionId).setJournal(new InMemoryJournal());
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snapshots);
    let recoveredState: State | null = null;
    class Recoverer extends CountingActor {
      override onRecoveryComplete(s: State): void { recoveredState = s; }
    }
    sys2.actorOf(Props.create(() => new Recoverer('a', { algorithm: 'none' }, enc)), 'a');
    await sleep(40);
    expect(recoveredState).toEqual({ count: 2 });
    await sys2.terminate();
  });
});

/* ----------------------- DurableStateActor hooks ------------------------- */

type DsCmd =
  | { kind: 'set'; v: number; replyTo: ActorRef }
  | { kind: 'get'; replyTo: ActorRef };

class Counter extends DurableStateActor<DsCmd, { v: number }> {
  constructor(
    settings: ConstructorParameters<typeof DurableStateActor<DsCmd, { v: number }>>[0],
    private readonly _compression?: CompressionConfig,
    private readonly _encryption?: EncryptionConfig,
  ) { super(settings); }
  protected override compression(): CompressionConfig | undefined { return this._compression; }
  protected override encryption(): EncryptionConfig | undefined { return this._encryption; }
  override async onCommand(cmd: DsCmd): Promise<void> {
    if (cmd.kind === 'set') { await this.persist({ v: cmd.v }); cmd.replyTo.tell({ ok: true } as never); }
    else cmd.replyTo.tell({ v: this.state.v } as never);
  }
}

describe('DurableStateActor — actor-level compression / encryption hooks', () => {
  test('compression hook flips contentEncoding on the underlying put', async () => {
    const seen: string[] = [];
    const wrapped = wrapPut(backend, (_k, opts) => seen.push(opts?.contentEncoding ?? 'none'));
    const store = new ObjectStorageDurableStateStore({
      backend: wrapped,
      compression: { algorithm: 'gzip' },
    });
    const sys = ActorSystem.create('ds-comp', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = makeProbe(sys);
    const ref = sys.actorOf(Props.create(() =>
      new Counter({ persistenceId: 'a', store, emptyState: () => ({ v: 0 }) }, { algorithm: 'zstd' }) as unknown as ActorBase<DsCmd>,
    ), 'a');
    ref.tell({ kind: 'set', v: 7, replyTo: probe.ref });
    await sleep(40);
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) expect(e).toBe('zstd');
    await sys.terminate();
  });

  test('encryption hook round-trips state without leaking plaintext', async () => {
    const masterKey = new Uint8Array(32).fill(0xcd);
    const enc: EncryptionConfig = { mode: 'client-aes256-gcm', masterKey };
    const store = new ObjectStorageDurableStateStore({ backend });

    const sys = ActorSystem.create('ds-aes', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = makeProbe(sys);
    const ref = sys.actorOf(Props.create(() =>
      new Counter({ persistenceId: 'b', store, emptyState: () => ({ v: 0 }) },
        { algorithm: 'none' }, enc) as unknown as ActorBase<DsCmd>,
    ), 'b');
    ref.tell({ kind: 'set', v: 12345, replyTo: probe.ref });
    await sleep(40);
    await sys.terminate();

    // The plaintext "12345" must not appear in the on-disk body.
    const fetched = await backend.get('b/state.json');
    expect(fetched.isSome()).toBe(true);
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(fetched.toNullable()!.body);
    expect(raw.includes('12345')).toBe(false);

    // Restart on the same backend with the same hook → recovery decrypts.
    const sys2 = ActorSystem.create('ds-aes-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe2 = makeProbe(sys2);
    const ref2 = sys2.actorOf(Props.create(() =>
      new Counter({ persistenceId: 'b', store, emptyState: () => ({ v: 0 }) },
        { algorithm: 'none' }, enc) as unknown as ActorBase<DsCmd>,
    ), 'b');
    ref2.tell({ kind: 'get', replyTo: probe2.ref });
    await sleep(40);
    expect(probe2.received).toContainEqual({ v: 12345 });
    await sys2.terminate();
  });
});

/* ------------------------- helpers ------------------------------------- */

function wrapPut(
  inner: FilesystemObjectStorageBackend,
  spy: (key: string, opts: { contentEncoding?: string } | undefined) => void,
): FilesystemObjectStorageBackend {
  // Lightweight passthrough wrapper that preserves the `instanceof` shape
  // expected by the snapshot/duarble-state stores.
  const w = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner);
  w.put = async (key: string, body: Uint8Array, opts: { contentEncoding?: string }) => {
    spy(key, opts);
    return inner.put(key, body, opts);
  };
  return w as FilesystemObjectStorageBackend;
}

function makeProbe(sys: ActorSystem): { ref: ActorRef; received: unknown[] } {
  const received: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Actor } = require('../../../../src/Actor.js') as { Actor: new <T>() => { onReceive(_: T): void } };
  class P extends (Actor as new () => { onReceive(_: unknown): void }) {
    onReceive(m: unknown): void { received.push(m); }
  }
  const ref = sys.actorOf(Props.create(() => new P() as unknown as ActorBase<unknown>), `p-${Math.random().toString(36).slice(2, 6)}`);
  return { ref, received };
}
