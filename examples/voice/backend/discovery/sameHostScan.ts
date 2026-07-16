/**
 * `SeedProvider` that discovers cluster peers by walking a TCP-port
 * range on the **same host** and probing each port for a live
 * listener.  Every port that comes back as "in use" is reported as
 * a seed; ports the OS would let us bind on are free.
 *
 * This is the same-host-no-config sibling of the framework's other
 * `SeedProvider` impls:
 *
 *   - `ConfigSeedProvider`         — fixed list (env vars, HOCON).
 *   - `DnsSeedProvider`            — SRV/A-record lookups.
 *   - `KubernetesApiSeedProvider`  — live Pod IPs from the K8s API.
 *   - `AggregateSeedProvider`      — chain of the above.
 *
 * For a local 3-terminal demo none of those bundled providers is a
 * fit — there is no DNS to query, no K8s to ask, and no env var
 * the user wants to set.  Walking the port range is the
 * lightest-weight thing that works.  This module ships with the
 * sample, not the framework, on purpose: it's a workflow shim, not
 * a production primitive.
 *
 * Pair it with {@link pickFirstFreePort} to choose THIS node's
 * cluster-port.  Both helpers consult the same range so the
 * "occupied below me, free at me" invariant holds.
 *
 * Limitations.  Only works for peers on the same host (`isPortFree`
 * is a same-host probe).  Cross-machine clusters need a real
 * provider — pick the bundled one that matches your environment
 * or compose them with `AggregateSeedProvider`.
 */
import { createServer, type AddressInfo } from 'node:net';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { SeedProvider } from '../../../../src/discovery/SeedProvider.js';

export interface SameHostScanSettings {
  /** Cluster system name — needed to format `system@host:port`. */
  readonly systemName: string;
  /** Host to bind / scan.  Same value `Cluster.join` will use. */
  readonly host: string;
  /** First port in the cluster's auto-discovery range. */
  readonly basePort: number;
  /** Hard cap on how far the scan walks beyond `basePort`. */
  readonly maxSlots: number;
}

export class SameHostScanSeedProvider implements SeedProvider {
  constructor(private readonly settings: SameHostScanSettings) {}

  /** Every occupied port in `[basePort, basePort + maxSlots)`. */
  async lookup(): Promise<NodeAddress[]> {
    const seeds: NodeAddress[] = [];
    for (let i = 0; i < this.settings.maxSlots; i++) {
      const port = this.settings.basePort + i;
      if (!(await isPortFree(this.settings.host, port))) {
        seeds.push(new NodeAddress(this.settings.systemName, this.settings.host, port));
      }
    }
    return seeds;
  }
}

/**
 * Pick the lowest port in `[basePort, basePort + maxSlots)` that is
 * not currently in use, and reserve it conceptually for the caller.
 *
 * There IS a TOCTOU race against another node started in parallel
 * — both probe-and-find-free, both try to bind, the loser gets
 * `EADDRINUSE` from `Cluster.join`.  For a demo that's fine; for
 * production you'd serialize starts via your orchestrator.
 *
 * Throws when every slot is occupied (rare, but possible if the
 * user spawned more nodes than `maxSlots`).
 */
export async function pickFirstFreePort(options: {
  host: string;
  basePort: number;
  maxSlots: number;
}): Promise<number> {
  for (let i = 0; i < options.maxSlots; i++) {
    const candidate = options.basePort + i;
    if (await isPortFree(options.host, candidate)) return candidate;
  }
  throw new Error(
    `all ${options.maxSlots} cluster-port slots starting at ${options.basePort} are in use`,
  );
}

/**
 * Bind a fresh listener on `host:port` and tear it down again.
 * Returns true if the bind succeeded (port free), false if
 * `EADDRINUSE` or any other bind error fired (port unusable).
 */
function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE is the canonical "occupied" signal.  Any other
      // bind error is also treated as "don't try this port" — we
      // would rather skip than crash later.
      void err;
      resolve(false);
    });
    probe.once('listening', () => {
      const actual = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(actual === port));
    });
    probe.listen(port, host);
  });
}
