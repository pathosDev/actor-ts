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
