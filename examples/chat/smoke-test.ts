/**
 * End-to-end smoke test for the chat backend.
 *
 *   bun examples/chat/smoke-test.ts                          # default :8080
 *   bun examples/chat/smoke-test.ts ws://127.0.0.1:8080/ws   # explicit
 *
 * Verifies:
 *   1. Login flow via WS.
 *   2. Auto-join + initial rooms / users frames.
 *   3. History reply for the user's primary room (#general).
 *   4. Send → broadcast roundtrip (publish-fan-out).
 *   5. History persistence: a fresh connection sees previous messages.
 *   6. (#98) User-created rooms: alice creates a room, bob sees the
 *      `room-added` broadcast, both join it, and a message round-trips.
 *   7. (#100) Direct messages: alice DMs bob via `@bob`, both sides
 *      observe the `message` frame routed through the DM channel.
 *   8. (#103) Typing indicators: alice sends `typing` for #general,
 *      bob receives `user-typing`; alice does not echo to herself.
 *   9. (#103) Read receipts: alice sends a message, bob acks
 *      `read-up-to`, alice observes the `read-receipts` broadcast.
 *  10. (#99) Auth hardening: wrong password is rejected, a valid
 *      token resumes a session, a revoked token resume is rejected,
 *      a tampered token resume is rejected.
 *
 * Run against a **single-node bootstrap** for reliable verification:
 *
 *   bun examples/chat/backend/main.ts --port 2551
 *   bun examples/chat/smoke-test.ts
 *
 * The multi-node case adds cross-shard routing into the picture and
 * has its own test (`failover-test.ts`) — that one focuses on the
 * HTTP-singleton fail-over rather than the messaging round-trip.
 *
 * Exit code 0 on success, non-zero on first failure.
 */

const URL_ARG = process.argv[2] ?? 'ws://127.0.0.1:8080/ws';

interface ServerMessage { kind: string; [k: string]: unknown }

class ChatClient {
  readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  readonly waitingFor: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (ev) => {
      const message = JSON.parse(ev.data as string) as ServerMessage;
      this.received.push(message);
      for (let i = this.waitingFor.length - 1; i >= 0; i--) {
        const waiter = this.waitingFor[i]!;
        if (waiter.pred(message)) {
          waiter.resolve(message);
          this.waitingFor.splice(i, 1);
        }
      }
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('connect error')));
    });
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  await(pred: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> {
    const existing = this.received.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for predicate')), timeoutMs);
      this.waitingFor.push({
        pred,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
      });
    });
  }

  close(): void {
    try { this.ws.close(1000); } catch { /* ignore */ }
  }
}

function fail(message: string): never {
  console.error('✗', message);
  process.exit(1);
}
function ok(message: string): void { console.log('✔', message); }

/** Wait until `pred` has matched `n` distinct received messages. */
function waitForCount(c: ChatClient, pred: (m: ServerMessage) => boolean, n: number, timeoutMs: number): Promise<void> {
  let already = c.received.filter(pred).length;
  if (already >= n) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`count timeout (got ${already}/${n})`)), timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const message = JSON.parse(ev.data as string) as ServerMessage;
      if (pred(message)) already++;
      if (already >= n) {
        clearTimeout(timer);
        c.ws.removeEventListener('message', onMessage as EventListener);
        resolve();
      }
    };
    c.ws.addEventListener('message', onMessage as EventListener);
  });
}

async function main(): Promise<void> {
  // ---------- pass 1: login alice + send 3 messages ----------
  console.log('— pass 1: login + send —');
  const clientA = new ChatClient(URL_ARG);
  await clientA.open();
  clientA.send({ kind: 'login', username: 'alice', password: 'wonderland' });

  const li = await clientA.await((m) => m.kind === 'logged-in' || m.kind === 'login-failed');
  if (li.kind !== 'logged-in') fail(`login-failed: ${(li as ServerMessage).reason}`);
  ok('logged in as alice');

  await clientA.await((m) => m.kind === 'rooms');
  ok('received rooms list');

  // Synchronization point: wait until we've seen `users` AND
  // `history` for #general — that confirms our subscribe was
  // processed AND the sharded ChatRoomActor responded.  The
  // history reply comes back through the cross-node ActorRef
  // mechanism, so receiving it also tells us cross-node routing
  // is healthy.  By this time the pubsub-mediator has had ample
  // gossip cycles to know about our subscribe on every node.
  await clientA.await((m) => m.kind === 'users' && (m as ServerMessage).room === 'general', 5000);
  await clientA.await((m) => m.kind === 'history' && (m as ServerMessage).room === 'general', 5000);
  // One extra anti-jitter sleep — eagerGossip is fire-and-forget;
  // give a margin before the first send to make sure the publish
  // path knows about our subscriber on whichever node hosts the
  // shard.
  await new Promise((r) => setTimeout(r, 750));

  for (const text of ['hello world', 'second msg', 'third msg']) {
    clientA.send({ kind: 'send', room: 'general', text });
  }

  // Wait for the 3 broadcast echoes.  Single-node cluster needs a
  // moment for self-up + shard-allocation before the first message
  // fully propagates.
  await waitForCount(clientA, (m) =>
    m.kind === 'message' &&
    (m as ServerMessage).room === 'general' &&
    ((m as ServerMessage).from as string) === 'alice', 3, 10_000,
  );
  ok('received 3 broadcast echoes');

  clientA.close();
  await new Promise((r) => setTimeout(r, 200));

  // ---------- pass 2: bob logs in, expects history ----------
  console.log('— pass 2: history replay —');
  const clientB = new ChatClient(URL_ARG);
  await clientB.open();
  clientB.send({ kind: 'login', username: 'bob', password: 'builder' });
  const bli = await clientB.await((m) => m.kind === 'logged-in' || m.kind === 'login-failed');
  if (bli.kind !== 'logged-in') fail(`bob login-failed`);
  ok('logged in as bob');

  const hist = (await clientB.await(
    (m) => m.kind === 'history' && (m as ServerMessage).room === 'general',
  )) as ServerMessage & { messages: Array<{ from: string; text: string }> };
  if (!Array.isArray(hist.messages) || hist.messages.length < 3) {
    fail(`history too short: ${JSON.stringify(hist.messages)}`);
  }
  const last3 = hist.messages.slice(-3);
  if (last3.some((m) => m.from !== 'alice')) fail(`history wrong sender`);
  if (last3[0]!.text !== 'hello world') fail(`history wrong text: ${last3[0]!.text}`);
  ok(`history has ${hist.messages.length} messages, last 3 are alice's`);

  // ---------- pass 3: user-created room (#98) ----------
  console.log('— pass 3: user-created room —');
  // Unique name per run so the test stays idempotent across restarts
  // — the directory ORSet keeps state in DD memory but the seed of
  // DEFAULT_ROOMS is always present.  A fresh name avoids "already
  // exists" if the test is run twice against the same backend.
  const roomName = `smoke-${Date.now().toString(36)}`;

  const a2 = new ChatClient(URL_ARG);
  const b2 = new ChatClient(URL_ARG);
  await Promise.all([a2.open(), b2.open()]);
  a2.send({ kind: 'login', username: 'alice', password: 'wonderland' });
  b2.send({ kind: 'login', username: 'bob',   password: 'builder' });
  await a2.await((m) => m.kind === 'logged-in');
  await b2.await((m) => m.kind === 'logged-in');

  // Wait for both clients to receive the initial `rooms` frame so
  // we know each has subscribed to the directory before alice asks
  // for the create — otherwise bob might miss the broadcast.
  await a2.await((m) => m.kind === 'rooms');
  await b2.await((m) => m.kind === 'rooms');

  a2.send({ kind: 'create-room', name: roomName });

  // Both clients should see `room-added` with the new name.
  await a2.await((m) => m.kind === 'room-added' && (m as ServerMessage).name === roomName, 5000);
  await b2.await((m) => m.kind === 'room-added' && (m as ServerMessage).name === roomName, 5000);
  ok(`both clients saw room-added(${roomName})`);

  // Both join the new room and round-trip a message.
  a2.send({ kind: 'join', room: roomName });
  b2.send({ kind: 'join', room: roomName });
  // Give the subscriptions a gossip tick — same anti-jitter margin
  // we use in pass 1 before the first send.
  await new Promise((r) => setTimeout(r, 750));
  a2.send({ kind: 'send', room: roomName, text: 'hi from alice in new room' });
  await b2.await(
    (m) => m.kind === 'message'
        && (m as ServerMessage).room === roomName
        && (m as ServerMessage).from === 'alice',
    5000,
  );
  ok(`bob received alice's message in #${roomName}`);

  a2.close(); b2.close();
  await new Promise((r) => setTimeout(r, 200));

  // ---------- pass 4: direct messages (#100) ----------
  console.log('— pass 4: direct messages —');
  const a3 = new ChatClient(URL_ARG);
  const b3 = new ChatClient(URL_ARG);
  await Promise.all([a3.open(), b3.open()]);
  a3.send({ kind: 'login', username: 'alice', password: 'wonderland' });
  b3.send({ kind: 'login', username: 'bob',   password: 'builder' });
  await a3.await((m) => m.kind === 'logged-in');
  await b3.await((m) => m.kind === 'logged-in');
  // Anti-jitter: give both sides a moment to subscribe to their DM
  // inbox topics before the first DM is sent.  Inbox subscriptions
  // happen during `activate()` after `logged-in` — usually instant,
  // but the gossip-driven mediator may take a tick to propagate.
  await new Promise((r) => setTimeout(r, 750));

  // alice DMs bob.
  a3.send({ kind: 'send', room: '@bob', text: 'private hi from alice' });
  // alice should see her own outgoing DM via her inbox subscription —
  // the channel actor publishes to both participants.
  await a3.await(
    (m) => m.kind === 'message'
        && (m as ServerMessage).room === '@bob'
        && (m as ServerMessage).from === 'alice'
        && (m as ServerMessage).text === 'private hi from alice',
    5000,
  );
  // bob receives it as `@alice` (his side renders the other party).
  await b3.await(
    (m) => m.kind === 'message'
        && (m as ServerMessage).room === '@alice'
        && (m as ServerMessage).from === 'alice'
        && (m as ServerMessage).text === 'private hi from alice',
    5000,
  );
  ok('alice→bob DM delivered to both sides');

  // bob replies; same round-trip in the other direction.
  b3.send({ kind: 'send', room: '@alice', text: 'private hi from bob' });
  await a3.await(
    (m) => m.kind === 'message'
        && (m as ServerMessage).room === '@bob'
        && (m as ServerMessage).from === 'bob'
        && (m as ServerMessage).text === 'private hi from bob',
    5000,
  );
  ok('bob→alice DM delivered');

  // History request: bob "joins" `@alice` and expects to see the
  // two messages he just took part in.
  b3.send({ kind: 'join', room: '@alice' });
  const directMessageHistory = (await b3.await(
    (m) => m.kind === 'history' && (m as ServerMessage).room === '@alice',
    5000,
  )) as ServerMessage & { messages: Array<{ from: string; text: string }> };
  if (!Array.isArray(directMessageHistory.messages) || directMessageHistory.messages.length < 2) {
    fail(`DM history too short: ${JSON.stringify(directMessageHistory.messages)}`);
  }
  ok(`DM history has ${directMessageHistory.messages.length} messages`);

  a3.close(); b3.close();
  await new Promise((r) => setTimeout(r, 200));

  // ---------- pass 5: typing indicators (#103) ----------
  console.log('— pass 5: typing indicators —');
  const a4 = new ChatClient(URL_ARG);
  const b4 = new ChatClient(URL_ARG);
  await Promise.all([a4.open(), b4.open()]);
  a4.send({ kind: 'login', username: 'alice', password: 'wonderland' });
  b4.send({ kind: 'login', username: 'bob',   password: 'builder' });
  await a4.await((m) => m.kind === 'logged-in');
  await b4.await((m) => m.kind === 'logged-in');
  // Both are auto-joined to #general; wait until both have the
  // subscription registered so the typing broadcast isn't lost.
  await a4.await((m) => m.kind === 'users' && (m as ServerMessage).room === 'general', 5000);
  await b4.await((m) => m.kind === 'users' && (m as ServerMessage).room === 'general', 5000);
  await new Promise((r) => setTimeout(r, 500));

  a4.send({ kind: 'typing', room: 'general' });
  // bob receives the indicator.
  await b4.await(
    (m) => m.kind === 'user-typing'
        && (m as ServerMessage).room === 'general'
        && (m as ServerMessage).username === 'alice',
    3000,
  );
  ok('bob observed user-typing(alice, general)');

  // Server filters self-echoes: alice must NOT see her own typing
  // broadcast.  Brief wait — if it were going to arrive it would
  // arrive within the same gossip-tick window as bob's reception.
  await new Promise((r) => setTimeout(r, 300));
  const selfEcho = a4.received.find((m) =>
    m.kind === 'user-typing'
    && (m as ServerMessage).room === 'general'
    && (m as ServerMessage).username === 'alice',
  );
  if (selfEcho) fail(`alice saw her own typing echo (server should filter)`);
  ok('alice did not receive a self-echo');

  a4.close(); b4.close();
  await new Promise((r) => setTimeout(r, 200));

  // ---------- pass 6: read receipts (#103 slice 2) ----------
  console.log('— pass 6: read receipts —');
  const a5 = new ChatClient(URL_ARG);
  const b5 = new ChatClient(URL_ARG);
  await Promise.all([a5.open(), b5.open()]);
  a5.send({ kind: 'login', username: 'alice', password: 'wonderland' });
  b5.send({ kind: 'login', username: 'bob',   password: 'builder' });
  await a5.await((m) => m.kind === 'logged-in');
  await b5.await((m) => m.kind === 'logged-in');
  await a5.await((m) => m.kind === 'users' && (m as ServerMessage).room === 'general', 5000);
  await b5.await((m) => m.kind === 'users' && (m as ServerMessage).room === 'general', 5000);
  await new Promise((r) => setTimeout(r, 500));

  // alice sends a message; alice should see her own echo via the
  // room broadcast.
  a5.send({ kind: 'send', room: 'general', text: 'mark-me-read-please' });
  const echo = await a5.await(
    (m) => m.kind === 'message'
        && (m as ServerMessage).room === 'general'
        && (m as ServerMessage).from === 'alice'
        && (m as ServerMessage).text === 'mark-me-read-please',
    5000,
  ) as ServerMessage & { ts: number };
  const sentTs = echo.ts;
  // bob receives the same broadcast.
  await b5.await(
    (m) => m.kind === 'message'
        && (m as ServerMessage).room === 'general'
        && (m as ServerMessage).text === 'mark-me-read-please',
    5000,
  );

  // bob marks it read.  Server broadcasts read-receipts to all
  // subscribers, including alice.
  b5.send({ kind: 'read-up-to', room: 'general', ts: sentTs });

  // alice should observe a read-receipts frame for #general with
  // bob's name at >= sentTs.  The receipts feed replays from the DD
  // snapshot on every change, so the second-or-later frame should
  // carry the new pointer.
  await a5.await(
    (m) => m.kind === 'read-receipts'
        && (m as ServerMessage).room === 'general'
        && typeof (m as ServerMessage).receipts === 'object'
        && ((m as ServerMessage).receipts as Record<string, number>)['bob'] !== undefined
        && ((m as ServerMessage).receipts as Record<string, number>)['bob']! >= sentTs,
    5000,
  );
  ok(`alice observed read-receipts(bob >= ${sentTs}) for #general`);

  // Monotonic guard: bob sends a stale `read-up-to` with a smaller
  // ts.  The server must not roll bob's pointer backwards.  After
  // a brief settle window, any read-receipts frame for bob must
  // still show ts ≥ sentTs.
  b5.send({ kind: 'read-up-to', room: 'general', ts: 1 });
  await new Promise((r) => setTimeout(r, 500));
  // Inspect the most recent read-receipts frame alice saw — it
  // should still report bob at >= sentTs.
  const allReceipts = a5.received.filter((m) =>
    m.kind === 'read-receipts' && (m as ServerMessage).room === 'general',
  ) as Array<ServerMessage & { receipts: Record<string, number> }>;
  const latest = allReceipts[allReceipts.length - 1];
  if (!latest || (latest.receipts.bob ?? 0) < sentTs) {
    fail(`monotonic guard broke: bob's read-up-to went backwards`);
  }
  ok('monotonic guard prevents stale read-up-to from rolling back');

  a5.close(); b5.close();
  await new Promise((r) => setTimeout(r, 200));

  // ---------- pass 7: auth hardening (#99) ----------
  console.log('— pass 7: auth hardening —');

  // 7a. wrong password must be rejected.
  const a6 = new ChatClient(URL_ARG);
  await a6.open();
  a6.send({ kind: 'login', username: 'alice', password: 'wrong-password' });
  const badLogin = await a6.await((m) => m.kind === 'logged-in' || m.kind === 'login-failed');
  if (badLogin.kind !== 'login-failed') {
    fail(`bcrypt verify accepted a wrong password`);
  }
  ok('wrong password rejected');
  a6.close();
  await new Promise((r) => setTimeout(r, 200));

  // 7b. valid token resume.
  const a7 = new ChatClient(URL_ARG);
  await a7.open();
  a7.send({ kind: 'login', username: 'alice', password: 'wonderland' });
  const li7 = await a7.await((m) => m.kind === 'logged-in' || m.kind === 'login-failed') as
    ServerMessage & { token?: string };
  if (li7.kind !== 'logged-in' || typeof li7.token !== 'string') {
    fail(`alice login failed`);
  }
  const goodToken = li7.token;
  a7.close();
  await new Promise((r) => setTimeout(r, 200));

  const a8 = new ChatClient(URL_ARG);
  await a8.open();
  a8.send({ kind: 'resume', token: goodToken });
  const resumed = await a8.await((m) => m.kind === 'logged-in' || m.kind === 'login-failed');
  if (resumed.kind !== 'logged-in') {
    fail(`valid token resume rejected: ${(resumed as ServerMessage).reason}`);
  }
  ok('valid token resume accepted');

  // 7c. revoked token is rejected.  Logout on a8 revokes the token
  // server-side; we reconnect with the same token and expect refusal.
  a8.send({ kind: 'logout' });
  // Brief settle window for the revocation to propagate via DD.  For
  // a single-node demo this is essentially immediate, but a real
  // cluster needs a gossip tick.
  await new Promise((r) => setTimeout(r, 750));
  a8.close();

  const a9 = new ChatClient(URL_ARG);
  await a9.open();
  a9.send({ kind: 'resume', token: goodToken });
  const revoked = await a9.await((m) => m.kind === 'logged-in' || m.kind === 'login-failed', 5000);
  if (revoked.kind !== 'login-failed') {
    fail(`revoked token still resumes (revocation set not consulted?)`);
  }
  ok('revoked token rejected');
  a9.close();
  await new Promise((r) => setTimeout(r, 200));

  // 7d. tampered token (HMAC mismatch) is rejected.  Flip the last
  // base64 char of the signature half — invalidates the MAC.
  const dot = goodToken.indexOf('.');
  const tampered = goodToken.slice(0, -1) + (goodToken.endsWith('A') ? 'B' : 'A');
  if (dot < 0 || tampered === goodToken) fail(`couldn't construct tampered token`);
  const a10 = new ChatClient(URL_ARG);
  await a10.open();
  a10.send({ kind: 'resume', token: tampered });
  const forged = await a10.await((m) => m.kind === 'logged-in' || m.kind === 'login-failed', 3000);
  if (forged.kind !== 'login-failed') {
    fail(`tampered token accepted (HMAC verify not running?)`);
  }
  ok('tampered token rejected');
  a10.close();

  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
}

main().catch((e) => fail((e as Error).message));
