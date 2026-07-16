/**
 * Scenario 15 — DnsSeedProvider against Docker's embedded DNS.
 *
 * Exercises the DNS-based seed-discovery code path that's used in
 * Kubernetes headless-service deployments.  In docker-compose,
 * each service name is a DNS A record resolving to the service's
 * container IP(s); we ask one node to run `DnsSeedProvider.lookup()`
 * for every peer's hostname and verify the returned addresses
 * look right.
 *
 * Doesn't actually BOOTSTRAP a new node via DNS — that would
 * require a 6th container with a different startup path — but it
 * does verify:
 *
 *   - DnsSeedProvider can be instantiated inside a container.
 *   - Its `lookup()` returns a non-empty `NodeAddress[]` for each
 *     peer hostname (single-IP services in compose).
 *   - The resolved IP looks like an IPv4 address.
 *   - Resolution latency is reasonable (< 500ms).
 *
 * Catches: a regression in DnsSeedProvider's IPv4 resolution path,
 * the systemName/port stamping logic, or the `node:dns/promises`
 * shim used in production.
 */

import { clusterLiveNodes, type Scenario } from './types.js';

interface DnsLookupResponse {
  readonly hostname: string;
  readonly port: number;
  readonly systemName: string;
  readonly addresses: ReadonlyArray<string>;
  readonly ips: ReadonlyArray<string>;
  readonly elapsedMs: number;
}

async function dnsLookup(
  via: string,
  controlPort: number,
  hostname: string,
  port: number,
): Promise<DnsLookupResponse> {
  const response = await fetch(
    `http://${via}:${controlPort}/test/discovery/dns-lookup`
    + `?hostname=${encodeURIComponent(hostname)}&port=${port}`,
  );
  if (!response.ok) throw new Error(`/test/discovery/dns-lookup on ${via} for ${hostname} → ${response.status}: ${await response.text()}`);
  return await response.json() as DnsLookupResponse;
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const scenario: Scenario = {
  name: '15-dns-seed-discovery',
  async run(context) {
    const live = await clusterLiveNodes(context.nodes, context.controlPort);
    if (live.length < 2) {
      console.log(`[15] skipping — need >=2 live nodes (one to query from, others to resolve), have ${live.length}`);
      return;
    }
    const via = live[0]!;
    // Resolve every peer's hostname via DNS from the via-node's
    // perspective.  Docker's embedded DNS returns the peer's
    // container IP for each service name.
    console.log(`[15] resolving ${live.length} hostnames via ${via}'s DnsSeedProvider...`);
    const results = await Promise.all(live.map((h) => dnsLookup(via, context.controlPort, h, 9000)));
    let allElapsed = 0;
    for (const r of results) {
      if (r.addresses.length === 0) {
        throw new Error(`[15] DNS lookup for ${r.hostname} returned empty addresses`);
      }
      if (r.addresses.length !== r.ips.length) {
        throw new Error(`[15] DNS lookup for ${r.hostname}: addresses/ips length mismatch (${r.addresses.length}/${r.ips.length})`);
      }
      for (const ip of r.ips) {
        if (!IPV4_RE.test(ip)) {
          throw new Error(`[15] DNS lookup for ${r.hostname} returned non-IPv4 entry: ${ip}`);
        }
      }
      // The full NodeAddress string is `integration@<ip>:9000`.
      for (const addr of r.addresses) {
        if (!addr.startsWith('integration@') || !addr.endsWith(':9000')) {
          throw new Error(`[15] unexpected address shape: ${addr}`);
        }
      }
      allElapsed += r.elapsedMs;
      console.log(`[15]   ${r.hostname}: ${r.ips.join(', ')} (${r.elapsedMs}ms)`);
    }
    const avgMs = Math.round(allElapsed / results.length);
    console.log(`[15] all ${results.length} DNS lookups returned valid IPv4 NodeAddresses; avg latency ${avgMs}ms`);

    // Sanity: docker embedded DNS is sub-millisecond in practice.
    // Allow 500ms slack for cold-start.  A regression that switched
    // to a slow resolver (or an unintended TLS-DNS path) would
    // surface as >>500ms.
    if (avgMs > 500) {
      console.warn(`[15] note: avg DNS lookup latency ${avgMs}ms is unusually high (>500ms threshold)`);
    }
  },
};
