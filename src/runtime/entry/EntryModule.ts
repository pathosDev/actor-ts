import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Where the program started: the module the runtime was asked to run.
 *
 * The parallelism extension needs it for one thing — the *convention* that
 * lets `actor-ts.parallelism.module` stay unset: an `actors.js` next to the
 * entry module is the actor module.  There is no runtime-neutral API for the
 * entry, so this is the fourth small seam beside HTTP, sockets and workers:
 * `Deno.mainModule` is already a URL; Bun and Node put the script's absolute
 * path in `process.argv[1]` (Deno does too, through its Node compatibility,
 * but its own answer is the authoritative one).  `null` where neither exists
 * — an embedded engine, a REPL — and the caller says what it needed the entry
 * for.
 */
export function entryModuleUrl(): URL | null {
  const scope = globalThis as { Deno?: { mainModule?: string }; process?: { argv?: string[] } };
  const mainModule = scope.Deno?.mainModule;
  if (typeof mainModule === 'string' && mainModule.length > 0) {
    try { return new URL(mainModule); } catch { /* not a URL: fall through to argv */ }
  }
  const script = scope.process?.argv?.[1];
  if (typeof script !== 'string' || script.length === 0) return null;
  try {
    return script.startsWith('file:') ? new URL(script) : pathToFileURL(script);
  } catch {
    return null;
  }
}

const ACTOR_MODULE_STEM = 'actors';
const ACTOR_MODULE_EXTENSIONS: ReadonlyArray<string> = ['.js', '.mjs', '.ts'];

/**
 * The conventional actor module next to `entry`, or `null` when none of the
 * candidates exists.  The entry's own extension is tried first — a `.ts`
 * program run by Bun keeps its actors in `actors.ts`, a compiled one in
 * `actors.js` — so a source tree that carries both never picks the wrong one.
 * Exposed for the error message, too: `conventionalActorModuleCandidates`
 * is what a missing module is reported as.
 */
export function conventionalActorModule(entry: URL): URL | null {
  for (const candidate of conventionalActorModuleCandidates(entry)) {
    if (entry.protocol !== 'file:') return null;
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

export function conventionalActorModuleCandidates(entry: URL): URL[] {
  const entryExtension = entry.pathname.slice(entry.pathname.lastIndexOf('.'));
  const ordered = [
    ...ACTOR_MODULE_EXTENSIONS.filter((extension) => extension === entryExtension),
    ...ACTOR_MODULE_EXTENSIONS.filter((extension) => extension !== entryExtension),
  ];
  return ordered.map((extension) => new URL(`./${ACTOR_MODULE_STEM}${extension}`, entry));
}
