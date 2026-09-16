import { Actor } from '../Actor.js';

/**
 * How an actor class is identified across the thread boundary (#1562, #1563).
 *
 * `postMessage` clones data — never a class, a closure or a module binding —
 * and no runtime maps a class object back to the module that defined it.  So
 * both sides import the same actor module and agree on a name for each class:
 * its **export name**, which survives a minifier and tells two classes that
 * happen to share a `.name` apart.  The worker builds `export name → class`
 * (what it spawns), the main thread the reverse (what it asks for); this
 * module is the one place both derive their half from, so they cannot drift.
 */

/** The subset of `Actor` a registry entry is checked against: constructible with no arguments. */
export type WorkerActorClass = new () => Actor<unknown>;

/** Where each export name came from — the second module to claim one is the error. */
export type ActorExportOrigins = Map<string, string>;

/**
 * Add every actor class `exports` carries to `registry`, keyed by export name.
 * Throws on a name two modules both export, unless it is the very same class
 * reached twice (a barrel re-exporting another module's class is fine).
 */
export function collectActorExports(
  href: string,
  exports: Record<string, unknown>,
  registry: Map<string, WorkerActorClass>,
  origins: ActorExportOrigins,
): void {
  for (const [exportName, value] of Object.entries(exports)) {
    if (!isActorClass(value)) continue;
    const previous = registry.get(exportName);
    if (previous !== undefined && previous !== value) {
      throw new Error(
        `two actor modules export '${exportName}' — ${origins.get(exportName)} and ${href}; `
        + 'an export name is the actor class\'s identity across the thread boundary, so it has to be unique',
      );
    }
    registry.set(exportName, value);
    origins.set(exportName, href);
  }
}

/**
 * An exported value the worker can `spawn`: a class whose prototype chain
 * reaches `Actor`.  The check is structural on purpose — a module bundled
 * separately may carry its own copy of `Actor`, and `instanceof` across two
 * copies is false — so it walks the prototype chain looking for the
 * `onReceive` contract every actor implements.
 */
export function isActorClass(value: unknown): value is WorkerActorClass {
  if (typeof value !== 'function') return false;
  if (value.prototype instanceof Actor) return true;
  let prototype: unknown = value.prototype;
  while (prototype !== null && typeof prototype === 'object') {
    if (Object.prototype.hasOwnProperty.call(prototype, 'onReceive')
      && typeof (prototype as { onReceive?: unknown }).onReceive === 'function'
      && prototype !== Object.prototype) {
      return true;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}
