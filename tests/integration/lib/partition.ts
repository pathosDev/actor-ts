/**
 * In-container network-fault injection (#313).
 *
 * The integration tests need to partition + delay nodes from each
 * other to exercise the cluster's failure-detection and downing
 * paths over a REAL TCP stack — not the in-memory transport with
 * synthetic partition hooks.  All the actual fault injection
 * happens INSIDE each container's network namespace using
 * `iptables` (packet drop) and `tc netem` (latency), so we don't
 * need privileged mode on the host — just `NET_ADMIN` on each
 * cluster-node container (granted via `cap_add` in
 * docker-compose.integration.yml).
 *
 * This module is invoked by the test-control HTTP server inside
 * each node container; the controller calls those endpoints to
 * coordinate scenarios from outside.
 */

import { promises as dns } from 'node:dns';
import { spawn } from 'node:child_process';

/**
 * Run a shell command, capture output, throw if non-zero exit.
 * Used for `iptables` / `tc` invocations that should succeed.
 * Set `allowFailure` to swallow non-zero exits — common when
 * deleting a rule that may not exist yet (e.g. `iptables -D` of
 * a never-installed rule returns exit code 2).
 */
async function sh(cmd: string, args: string[], allowFailure = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
    child.on('error', reject);
  });
}

/**
 * Resolve a hostname (typically another compose service name like
 * "node-b") to its first IPv4 address on the cluster network.
 * Docker's embedded DNS gives every container a stable hostname
 * matching its service name.
 */
async function resolveIp(host: string): Promise<string> {
  const addresses = await dns.resolve4(host);
  if (addresses.length === 0) {
    throw new Error(`partition.resolveIp: no A record for ${host}`);
  }
  return addresses[0]!;
}

/**
 * Drop every packet between this container and `peerHost` (both
 * directions).  Simulates a hard network partition — the cluster's
 * failure detector should mark the peer Unreachable within
 * `unreachableAfterMs`.
 *
 * Idempotent: running twice for the same peer adds a duplicate
 * rule; `healPeer` removes ALL matching rules so the net is the
 * same.  No-op semantics are preferable to "must check before
 * adding" for the partition.ts surface — the tests should treat
 * partition + heal as monotonic operations.
 */
export async function partitionPeer(peerHost: string): Promise<void> {
  const ip = await resolveIp(peerHost);
  await sh('iptables', ['-A', 'INPUT', '-s', ip, '-j', 'DROP']);
  await sh('iptables', ['-A', 'OUTPUT', '-d', ip, '-j', 'DROP']);
}

/**
 * Remove the drop rules installed by {@link partitionPeer}.
 * Iterates `-D` until the rule no longer exists, so a peer that
 * was partitioned more than once (test bug, race) is fully healed.
 */
export async function healPeer(peerHost: string): Promise<void> {
  const ip = await resolveIp(peerHost);
  // Up to 8 iterations — enough for any reasonable scenario; the
  // `-D` returns non-zero once there's nothing left to delete.
  for (let i = 0; i < 8; i++) {
    try {
      await sh('iptables', ['-D', 'INPUT', '-s', ip, '-j', 'DROP']);
    } catch { break; }
  }
  for (let i = 0; i < 8; i++) {
    try {
      await sh('iptables', ['-D', 'OUTPUT', '-d', ip, '-j', 'DROP']);
    } catch { break; }
  }
}

/**
 * Add a netem-delay qdisc on `eth0` so every outbound packet from
 * this container is delayed by `ms` milliseconds.  Affects ALL
 * peers — granular per-peer delay would need an HTB+netem stack
 * which is overkill for the first iteration's scenarios.
 *
 * Calling `delayAllEgress(ms)` twice replaces the previous qdisc
 * (delete-then-add) so latency tuning during a scenario is safe.
 */
export async function delayAllEgress(ms: number): Promise<void> {
  // Clean slate first (ignore if nothing was there).
  await sh('tc', ['qdisc', 'del', 'dev', 'eth0', 'root'], true);
  if (ms > 0) {
    await sh('tc', ['qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'delay', `${ms}ms`]);
  }
}

/**
 * Wipe every partition + delay rule this container has installed.
 * The controller calls this between scenarios so each starts from
 * a clean baseline.
 */
export async function clearAll(): Promise<void> {
  await sh('iptables', ['-F', 'INPUT'], true);
  await sh('iptables', ['-F', 'OUTPUT'], true);
  await sh('tc', ['qdisc', 'del', 'dev', 'eth0', 'root'], true);
}
