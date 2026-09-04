/**
 * The resolved-config inspector (#553).
 *
 * A merged HOCON tree answers "what is this setting now".  The question
 * that actually brings someone here is "why is it not what I wrote", and
 * that needs the layer as well as the value — the bundled default won,
 * `application.conf` won, or a code override won.
 *
 * A pull, not a stream: configuration is fixed when the system is built,
 * so there is nothing to push.  It is read once per panel open.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import {
  attributedConfigLeaves,
  resolveConfigLeaves,
  type ResolvedConfigLeaf,
} from '../../diagnostics/ConfigDump.js';
import { toWireValue } from '../internal/WireSerializer.js';
import {
  CONFIG_REDACTED,
  type ResolvedConfigEntry,
  type ResolvedConfigResult,
} from '../protocol/index.js';
import type { DevToolsServer } from '../DevToolsServer.js';

/**
 * Wires `config.resolved` onto the server.
 *
 * The walk, the layer attribution and the secret-path test are not here:
 * they are `src/diagnostics/ConfigDump.ts`, shared with the boot dump #867
 * added.  Two renderers of one merged tree that each walked it their own way
 * would be two chances to disagree about which layer won — and, worse, two
 * redaction rules, so a key withheld from the panel could still reach a log
 * file.  What stays here is the half that is genuinely the wire's: the size
 * caps `toWireValue` applies, and the `truncated` flag that reports them.
 */
export class ConfigMethods {
  constructor(private readonly system: ActorSystem) {}

  /** Register the method on `server`. */
  install(server: DevToolsServer): void {
    server.registerMethod('config.resolved', async () => this.onResolved());
  }

  private async onResolved(): Promise<ResolvedConfigResult> {
    const config = this.system.config;
    return {
      entries: resolveConfigLeaves(config).map(entryFor),
      applicationPath: config._sources()?.applicationPath ?? null,
      attributed: attributedConfigLeaves(config),
    };
  }
}

function entryFor(leaf: ResolvedConfigLeaf): ResolvedConfigEntry {
  const { path, layer: source, displaced: overridden } = leaf;
  if (leaf.secret) {
    // Redacted by PATH rather than by value: a password that happens to
    // look ordinary is still a password, and the key is what names it.
    return { path, value: CONFIG_REDACTED, source, overridden, truncated: false };
  }
  const wire = toWireValue(leaf.value);
  return { path, value: wire.value, source, overridden, truncated: wire.truncated };
}
