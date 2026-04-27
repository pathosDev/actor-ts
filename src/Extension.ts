import type { ActorSystem } from './ActorSystem.js';

/**
 * Marker interface for everything that can be installed as an extension on
 * an `ActorSystem`.  Its only real role is to let TypeScript distinguish
 * extensions from arbitrary objects in the public API; implementations are
 * free to expose any shape.
 */
export interface Extension {}

/**
 * Identifier + factory pair that the ActorSystem uses to lazily create and
 * cache an extension singleton.  Conceptually: the `key` gives identity,
 * the `createExtension` function produces the instance on first access.
 */
export interface ExtensionId<T extends Extension = Extension> {
  readonly key: symbol;
  readonly name: string;
  createExtension(system: ActorSystem): T;
}

/**
 * Helper: build an ExtensionId with a global-symbol-registered key so that
 * two distinct imports of the same module resolve to the same extension.
 */
export function extensionId<T extends Extension>(
  name: string,
  factory: (system: ActorSystem) => T,
): ExtensionId<T> {
  return {
    key: Symbol.for(`actor-ts.ext.${name}`),
    name,
    createExtension: factory,
  };
}

/**
 * Per-system registry.  Holds at most one instance per `ExtensionId.key`.
 * First `.get(id)` triggers `id.createExtension(system)` and caches the
 * result; subsequent calls return the same instance.
 */
export class Extensions {
  private readonly cache = new Map<symbol, Extension>();

  constructor(private readonly system: ActorSystem) {}

  /** Return the extension for `id`, creating it lazily if needed. */
  get<T extends Extension>(id: ExtensionId<T>): T {
    const cached = this.cache.get(id.key) as T | undefined;
    if (cached) return cached;
    const ext = id.createExtension(this.system);
    this.cache.set(id.key, ext);
    return ext;
  }

  /** True if the extension has already been created. */
  has<T extends Extension>(id: ExtensionId<T>): boolean {
    return this.cache.has(id.key);
  }

  /** Register a pre-built instance — useful for tests that mock an extension. */
  put<T extends Extension>(id: ExtensionId<T>, instance: T): void {
    this.cache.set(id.key, instance);
  }

  /** Eagerly initialise a batch of extensions (e.g. read from config). */
  preload(ids: ExtensionId[]): void {
    for (const id of ids) this.get(id);
  }

  /** Snapshot the names of currently-loaded extensions — diagnostic only. */
  loaded(): string[] {
    return Array.from(this.cache.keys())
      .map(k => Symbol.keyFor(k) ?? String(k));
  }
}
