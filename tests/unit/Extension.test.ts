import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { extensionId, Extensions, type Extension, type ExtensionId } from '../../src/Extension.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import {
  SerializationExtension,
  SerializationExtensionId,
} from '../../src/serialization/SerializationExtension.js';

class Counter implements Extension {
  constructor(public readonly startedAt: number) {}
  value = 0;
  inc(): void { this.value++; }
}

const CounterId: ExtensionId<Counter> = extensionId(
  'test.Counter',
  () => new Counter(Date.now()),
);

const factorySpyCount = { n: 0 };
const SpyId: ExtensionId<Counter> = extensionId(
  'test.SpyCounter',
  () => { factorySpyCount.n++; return new Counter(0); },
);

function newSystem(name = 'ext-test'): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
}

describe('extensionId', () => {
  test('creates an ExtensionId with a global-symbol key and name', () => {
    const a = extensionId('foo', () => ({} as Extension));
    const b = extensionId('foo', () => ({} as Extension));
    expect(a.key).toBe(b.key);      // same name → same symbol
    expect(a.name).toBe('foo');
  });

  test('different names yield different keys', () => {
    expect(extensionId('x', () => ({} as Extension)).key)
      .not.toBe(extensionId('y', () => ({} as Extension)).key);
  });
});

describe('Extensions registry', () => {
  test('lazy-initialises an extension on first get and caches it thereafter', async () => {
    factorySpyCount.n = 0;
    const sys = newSystem();
    const a = sys.extensions.get(SpyId);
    const b = sys.extensions.get(SpyId);
    expect(a).toBe(b);
    expect(factorySpyCount.n).toBe(1);
    await sys.terminate();
  });

  test('different extensions can coexist on the same system', async () => {
    const sys = newSystem();
    const c = sys.extensions.get(CounterId);
    const s = sys.extensions.get(SerializationExtensionId);
    expect(c).toBeInstanceOf(Counter);
    expect(s).toBeInstanceOf(SerializationExtension);
    expect(c === (s as unknown)).toBe(false);
    await sys.terminate();
  });

  test('separate ActorSystems have independent extension instances', async () => {
    const a = newSystem('ext-a');
    const b = newSystem('ext-b');
    const ca = a.extensions.get(CounterId);
    const cb = b.extensions.get(CounterId);
    expect(ca).not.toBe(cb);
    await a.terminate(); await b.terminate();
  });

  test('has() reports membership without creating', async () => {
    const sys = newSystem();
    expect(sys.extensions.has(CounterId)).toBe(false);
    sys.extensions.get(CounterId);
    expect(sys.extensions.has(CounterId)).toBe(true);
    await sys.terminate();
  });

  test('put() replaces the cached instance', async () => {
    const sys = newSystem();
    const stub = new Counter(-1);
    sys.extensions.put(CounterId, stub);
    expect(sys.extensions.get(CounterId)).toBe(stub);
    await sys.terminate();
  });

  test('preload() initialises multiple extensions up front', async () => {
    const sys = newSystem();
    expect(sys.extensions.has(CounterId)).toBe(false);
    expect(sys.extensions.has(SerializationExtensionId)).toBe(false);
    sys.extensions.preload([CounterId, SerializationExtensionId]);
    expect(sys.extensions.has(CounterId)).toBe(true);
    expect(sys.extensions.has(SerializationExtensionId)).toBe(true);
    await sys.terminate();
  });

  test('loaded() lists currently-cached extension names', async () => {
    const sys = newSystem();
    sys.extensions.get(CounterId);
    sys.extensions.get(SerializationExtensionId);
    const names = sys.extensions.loaded();
    expect(names).toContain('actor-ts.ext.test.Counter');
    expect(names).toContain('actor-ts.ext.SerializationExtension');
    await sys.terminate();
  });

  test('ActorSystem.extension is a shortcut for extensions.get', async () => {
    const sys = newSystem();
    const viaShortcut = sys.extension(CounterId);
    const viaRegistry = sys.extensions.get(CounterId);
    expect(viaShortcut).toBe(viaRegistry);
    await sys.terminate();
  });
});

describe('SerializationExtensionId integration', () => {
  test('returns a pre-configured SerializationExtension', async () => {
    const sys = newSystem();
    const ser = sys.extension(SerializationExtensionId);
    expect(ser).toBeInstanceOf(SerializationExtension);
    expect(ser.registeredIds()).toContain(1);   // JSON
    expect(ser.registeredIds()).toContain(2);   // CBOR
    await sys.terminate();
  });

  test('subsequent lookups return the exact same instance', async () => {
    const sys = newSystem();
    const a = sys.extension(SerializationExtensionId);
    const b = sys.extension(SerializationExtensionId);
    expect(a).toBe(b);
    await sys.terminate();
  });
});

describe('Extensions constructor', () => {
  test('can be instantiated directly (used by ActorSystem internally)', async () => {
    const sys = newSystem();
    const ext = new Extensions(sys);
    const c = ext.get(CounterId);
    expect(c).toBeInstanceOf(Counter);
    await sys.terminate();
  });
});
