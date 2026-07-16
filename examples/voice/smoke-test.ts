/**
 * Headless WebSocket round-trip smoke test for the voice sample.
 *
 * Boots a single-node voice cluster in the same process, opens two
 * WS clients (alice, bob), and walks all three modes:
 *
 *   1. 1:1 PTT  — alice presses on bob; bob receives a binary
 *                  envelope with alice's username prefix; alice
 *                  releases; bob receives `voice-incoming-end`.
 *   2. Group     — alice presses on `engineering`; bob (also in
 *                  engineering) receives.
 *   3. Room      — both enter `standup`; alice opens mic; bob
 *                  receives.
 *
 * Audio payload is a fake 32-byte buffer per "frame" — we're not
 * testing playback, only the relay path.  The server is a dumb
 * relay so this exercises the full envelope encoder + decoder
 * without a browser in the loop.
 *
 * Exit code is 0 on full pass, non-zero on any timeout / failure.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const HTTP_PORT = 8091;     // distinct from the default 8081 so this
                            // can be run while a real cluster is up
const CLUSTER_PORT = 2691;

interface Connection {
  ws: WebSocket;
  username: string;
  events: Array<{ kind: 'text'; data: unknown } | { kind: 'binary'; data: Uint8Array }>;
  ready: Promise<void>;
}

async function openConnection(username: string, password: string): Promise<Connection> {
  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws`);
  const events: Connection['events'] = [];
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`login timeout for ${username}`)), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'login', username, password })));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const buf = raw instanceof Buffer ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array();
        events.push({ kind: 'binary', data: buf });
        return;
      }
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      let m: any;
      try { m = JSON.parse(text); } catch { return; }
      events.push({ kind: 'text', data: m });
      if (m.type === 'logged-in') { clearTimeout(timer); resolve(); }
      if (m.type === 'login-failed') { clearTimeout(timer); reject(new Error(m.reason)); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  return { ws, username, events, ready };
}

async function waitFor<T>(
  ev: () => T | undefined, timeoutMs: number, label: string,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = ev();
    if (result !== undefined) return result;
    await delay(50);
  }
  throw new Error(`waitFor: ${label} timed out after ${timeoutMs}ms`);
}

function clearEvents(c: Connection): void { c.events.length = 0; }

function findText(c: Connection, predicate: (m: any) => boolean): any | undefined {
  return c.events.find((e) => e.kind === 'text' && predicate((e as any).data))?.['data'];
}

function findBinary(c: Connection, predicate?: (b: Uint8Array) => boolean): Uint8Array | undefined {
  const ev = c.events.find((e) => e.kind === 'binary' && (!predicate || predicate((e as any).data)));
  return ev?.['data'];
}

function decodeIncoming(buf: Uint8Array): { sender: string; opus: Uint8Array } {
  const nameLen = buf[0]!;
  const sender = new TextDecoder().decode(buf.subarray(1, 1 + nameLen));
  const opus = buf.subarray(1 + nameLen);
  return { sender, opus };
}

async function main(): Promise<void> {
  // Spawn the voice backend on isolated ports so we don't collide
  // with whatever else might be running.
  const child = spawn('bun', [
    'examples/voice/backend/main.ts',
    '--port', String(CLUSTER_PORT),
    '--http-port', String(HTTP_PORT),
    '--seeds', '',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let booted = false;
  child.stdout.on('data', (b: Buffer) => {
    const text = b.toString('utf-8');
    if (text.includes('HTTP server listening')) booted = true;
  });
  child.stderr.on('data', (b: Buffer) => process.stderr.write(b));

  try {
    await waitFor(() => booted || undefined, 15_000, 'cluster boot');
    await delay(500); // small grace for receptionist registration on the voice-session side

    // Two clients log in.
    const alice = await openConnection('alice', 'wonderland');
    const bob = await openConnection('bob', 'builder');
    await Promise.all([alice.ready, bob.ready]);
    console.log('login ok: alice + bob');

    // Wait until each side has received the directory + online-users
    // snapshot showing the other.  Receptionist gossip is on a 1 s
    // tick so a Find against alice's voice-user key may need a beat.
    await delay(1500);

    /* ---------------- Mode 1: 1:1 PTT ---------------- */
    clearEvents(alice); clearEvents(bob);
    alice.ws.send(JSON.stringify({ type: 'voice-target', mode: 'peer', target: 'bob' }));
    await waitFor(
      () => findText(alice, (m) => m.type === 'voice-target-ok' && m.key === 'bob'),
      3_000, 'voice-target-ok peer→bob',
    );

    const fakeOpus = new Uint8Array(32).fill(0x42);
    alice.ws.send(fakeOpus);
    const inFrame = await waitFor(
      () => findBinary(bob),
      2_000, 'bob receives 1:1 audio frame',
    );
    const decoded = decodeIncoming(inFrame);
    if (decoded.sender !== 'alice') throw new Error(`expected sender alice, got ${decoded.sender}`);
    console.log(`1:1 ok: bob received ${decoded.opus.byteLength} bytes from ${decoded.sender}`);

    alice.ws.send(JSON.stringify({ type: 'voice-stop' }));
    await waitFor(
      () => findText(bob, (m) => m.type === 'voice-incoming-end' && m.from === 'alice'),
      2_000, 'bob receives voice-incoming-end',
    );

    /* ---------------- Mode 2: 1:N group ---------------- */
    clearEvents(alice); clearEvents(bob);
    alice.ws.send(JSON.stringify({ type: 'voice-target', mode: 'group', group: 'engineering' }));
    await waitFor(
      () => findText(alice, (m) => m.type === 'voice-target-ok' && m.key === 'engineering'),
      2_000, 'voice-target-ok group→engineering',
    );
    alice.ws.send(fakeOpus);
    const inGroup = await waitFor(
      () => findBinary(bob),
      2_000, 'bob receives group audio',
    );
    const decGroup = decodeIncoming(inGroup);
    if (decGroup.sender !== 'alice') throw new Error(`group: expected alice, got ${decGroup.sender}`);
    console.log(`group ok: bob (engineering) heard ${decGroup.opus.byteLength} bytes`);
    alice.ws.send(JSON.stringify({ type: 'voice-stop' }));
    await waitFor(
      () => findText(bob, (m) => m.type === 'voice-incoming-end' && m.from === 'alice'),
      2_000, 'bob group end',
    );

    /* ---------------- Mode 3: N:N room ---------------- */
    clearEvents(alice); clearEvents(bob);
    alice.ws.send(JSON.stringify({ type: 'room-enter', room: 'standup' }));
    bob.ws.send(JSON.stringify({ type: 'room-enter', room: 'standup' }));
    await delay(500); // let DD ORSet converge
    alice.ws.send(JSON.stringify({ type: 'voice-target', mode: 'room', room: 'standup' }));
    await waitFor(
      () => findText(alice, (m) => m.type === 'voice-target-ok' && m.key === 'standup'),
      2_000, 'voice-target-ok room→standup',
    );
    alice.ws.send(fakeOpus);
    const inRoom = await waitFor(
      () => findBinary(bob),
      2_000, 'bob receives room audio',
    );
    const decRoom = decodeIncoming(inRoom);
    if (decRoom.sender !== 'alice') throw new Error(`room: expected alice, got ${decRoom.sender}`);
    console.log(`room ok: bob (standup) heard ${decRoom.opus.byteLength} bytes`);

    /* ---------------- self-filter ---------------- */
    // alice should NOT receive her own room audio.
    if (findBinary(alice)) throw new Error('self-filter violated: alice heard her own room frame');
    console.log('self-filter ok: alice did not hear own room audio');

    alice.ws.send(JSON.stringify({ type: 'voice-stop' }));
    await waitFor(
      () => findText(bob, (m) => m.type === 'voice-incoming-end' && m.from === 'alice'),
      2_000, 'bob room end',
    );

    alice.ws.close(); bob.ws.close();
    console.log('\n✓ all three modes round-tripped');
  } finally {
    child.kill('SIGINT');
    await delay(500);
  }
}

main().catch((err) => {
  process.stderr.write(`smoke-test FAILED: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
