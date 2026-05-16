/**
 * Shared types + helpers for integration scenarios (#313).
 */

export interface ControllerCtx {
  /** Hostnames of every cluster-node container, in compose-declaration order. */
  readonly nodes: ReadonlyArray<string>;
  /** Bearer token configured on every node's management HTTP. */
  readonly mgmtToken: string;
  /** Management HTTP port on every node. */
  readonly mgmtPort: number;
  /** Test-control HTTP port on every node. */
  readonly controlPort: number;
}

export interface Scenario {
  readonly name: string;
  run(ctx: ControllerCtx): Promise<void>;
}

/** Sleep N ms — `Bun.sleep` is bun-only, this works on Node too. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Poll `check()` until it returns true or `deadlineMs` elapses.
 * Throws if the deadline is reached.  Used by every scenario to
 * wait for state to converge — explicit deadline + explicit
 * polling interval makes the failure mode loud ("waited 10s for
 * X to converge, never happened") rather than a flaky timeout.
 */
export async function waitFor(
  description: string,
  check: () => Promise<boolean> | boolean,
  deadlineMs: number = 10_000,
  pollMs: number = 100,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const ok = await check();
      if (ok) return;
    } catch (e) {
      lastError = e;
    }
    await sleep(pollMs);
  }
  const detail = lastError ? ` (last error: ${(lastError as Error).message})` : '';
  throw new Error(`waitFor: "${description}" did not become true within ${deadlineMs}ms${detail}`);
}

/**
 * Fetch /test/members from one node and parse it.  Used to
 * answer "from node X's perspective, which peers are up?".
 */
export async function membersFrom(
  host: string,
  controlPort: number,
): Promise<Array<{ address: string; status: string }>> {
  const res = await fetch(`http://${host}:${controlPort}/test/members`);
  if (!res.ok) throw new Error(`/test/members on ${host} returned ${res.status}`);
  const body = await res.json() as {
    members: Array<{ address: string; status: string }>;
  };
  return body.members;
}

/** Convenience: how many members does the given node see in `up` state? */
export async function upCountFrom(host: string, controlPort: number): Promise<number> {
  const members = await membersFrom(host, controlPort);
  return members.filter((m) => m.status === 'up').length;
}

/** POST to a node's test-control endpoint with no body. */
export async function controlPost(
  host: string,
  controlPort: number,
  path: string,
): Promise<unknown> {
  const res = await fetch(`http://${host}:${controlPort}${path}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`POST http://${host}:${controlPort}${path} returned ${res.status}`);
  }
  return res.json().catch(() => null);
}

/**
 * Returns the subset of `allNodes` that are **still part of the
 * cluster** — not just "the HTTP server is reachable", which the
 * `/test/ping` check doesn't distinguish.  After a destructive
 * scenario calls `cluster.leave()`, the node-runner process keeps
 * running (and `/test/ping` keeps answering 200), but the local
 * `cluster` is shut down — message-routing endpoints like
 * `/test/singleton/who` then time out because the proxy doesn't
 * know who the leader is.
 *
 * Heuristic: a node is "cluster-live" when `/test/members` returns
 * a non-empty member list including itself with status `up`.  That
 * filters out both unreachable processes AND processes that have
 * gracefully left their cluster.
 */
export async function clusterLiveNodes(
  allNodes: ReadonlyArray<string>,
  controlPort: number,
): Promise<string[]> {
  const checks = await Promise.all(allNodes.map(async (h) => {
    try {
      const res = await fetch(`http://${h}:${controlPort}/test/members`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) return null;
      const body = await res.json() as {
        self: string;
        members: ReadonlyArray<{ address: string; status: string }>;
      };
      // The node sees itself as `up` and at least one other peer is
      // `up`.  An isolated post-leave node would have an empty
      // members list (or self marked `leaving`/`removed`).
      const self = body.members.find((m) => m.address === body.self);
      const upPeers = body.members.filter((m) => m.address !== body.self && m.status === 'up').length;
      if (self && self.status === 'up' && upPeers >= 1) return h;
      return null;
    } catch {
      return null;
    }
  }));
  return checks.filter((h): h is string => h !== null);
}
