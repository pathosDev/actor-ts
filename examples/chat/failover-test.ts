/**
 * Manual end-to-end failover verification.
 *
 *   bun examples/chat/failover-test.ts
 *
 * What it does (no test framework — plain script with assertions):
 *
 *   1. Spawns a 3-node chat-cluster locally.
 *   2. Polls until exactly one node has bound :8080 (the
 *      ClusterSingleton holder).
 *   3. Logs that node's PID, then kills it with the OS-level
 *      taskkill / kill (whichever is available).
 *   4. Polls again — expects a DIFFERENT PID to be bound to :8080
 *      within a few seconds.  That's the failover.
 *   5. Reaches HTTP `GET /` to confirm the new ingress serves
 *      requests.
 *
 * On Windows the script uses `Get-NetTCPConnection` via PowerShell
 * to read the bound-PID; on POSIX it falls back to `lsof`.  Adjust
 * if your platform isn't covered.
 *
 * This runs as a separate script rather than as part of the
 * regular smoke test because spawning 3 cluster nodes from inside
 * a test is slow + Windows-fragile and pollutes the chat
 * filesystem journal across runs.
 */
import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HTTP_PORT = 8080;
const NODES = [
  { port: 2551, seeds: '' },
  { port: 2552, seeds: 'localhost:2551' },
  { port: 2553, seeds: 'localhost:2551' },
];

const repoRoot = process.cwd();
const dataDir = join(repoRoot, 'examples', 'chat', 'data');

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg: string): void { console.log(`✔ ${msg}`); }

/** PID currently bound to the chat HTTP port — null if no listener. */
function pidOnPort(port: number): number | null {
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
        { encoding: 'utf-8' },
      ).trim();
      if (!out) return null;
      const lines = out.split(/\r?\n/).filter(Boolean);
      const pid = parseInt(lines[lines.length - 1]!, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch { return null; }
  }
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf-8' }).trim();
    if (!out) return null;
    return parseInt(out.split(/\s+/)[0]!, 10);
  } catch { return null; }
}

function kill(pid: number): void {
  if (process.platform === 'win32') {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

async function pollFor<T>(
  what: string,
  fn: () => T | null,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    await sleep(intervalMs);
  }
  fail(`timed out waiting for ${what}`);
}

async function httpGet(url: string): Promise<number> {
  try {
    const res = await fetch(url);
    return res.status;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  // Start fresh.
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const procs: ChildProcess[] = [];
  process.on('exit', () => {
    for (const p of procs) try { p.kill('SIGKILL'); } catch { /* ignore */ }
  });

  // Spawn the three nodes.
  for (const node of NODES) {
    const args = [
      'examples/chat/backend/main.ts',
      '--port', String(node.port),
    ];
    if (node.seeds) args.push('--seeds', node.seeds);
    const p = spawn('bun', args, {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    procs.push(p);
    await sleep(1000); // staggered start
  }
  ok(`3 cluster nodes started`);

  // Wait for the singleton to bind.
  const initialPid = await pollFor(
    `someone to bind :${HTTP_PORT}`,
    () => pidOnPort(HTTP_PORT),
    20_000,
  );
  ok(`initial singleton holder: PID ${initialPid}`);

  // Wait a bit for the cluster to fully converge before disrupting.
  await sleep(3000);

  // Sanity: the public port serves HTTP.
  const initialStatus = await httpGet(`http://127.0.0.1:${HTTP_PORT}/`);
  if (initialStatus !== 200) fail(`pre-failover GET / returned ${initialStatus}`);
  ok(`pre-failover GET / -> 200`);

  // Take the holder down.
  kill(initialPid);
  ok(`killed singleton holder PID ${initialPid}`);

  // A different PID should pick up :8080.
  const newPid = await pollFor(
    'a different PID to bind :8080',
    () => {
      const p = pidOnPort(HTTP_PORT);
      return p !== null && p !== initialPid ? p : null;
    },
    20_000,
  );
  ok(`failed over to PID ${newPid}`);

  // And it should answer HTTP.
  let status = 0;
  for (let i = 0; i < 10; i++) {
    status = await httpGet(`http://127.0.0.1:${HTTP_PORT}/`);
    if (status === 200) break;
    await sleep(300);
  }
  if (status !== 200) fail(`post-failover GET / returned ${status}`);
  ok(`post-failover GET / -> 200`);

  // Tear everything down.
  for (const p of procs) try { p.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(500);
  process.exit(0);
}

main().catch((e) => fail((e as Error).message));

// existsSync is imported but may not be used on every platform; keep
// it hot to avoid dead-code-elimination tripping the import.
void existsSync;
