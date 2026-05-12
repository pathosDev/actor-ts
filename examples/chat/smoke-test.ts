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

interface ServerMsg { type: string; [k: string]: unknown }

class ChatClient {
  readonly ws: WebSocket;
  readonly received: ServerMsg[] = [];
  readonly waitingFor: Array<{ pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data as string) as ServerMsg;
      this.received.push(m);
      for (let i = this.waitingFor.length - 1; i >= 0; i--) {
        const w = this.waitingFor[i]!;
        if (w.pred(m)) {
          w.res(m);
          this.waitingFor.splice(i, 1);
        }
      }
    });
  }

  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('connect error')));
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  await(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
    const existing = this.received.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout waiting for predicate')), timeoutMs);
      this.waitingFor.push({
        pred,
        res: (m) => { clearTimeout(timer); res(m); },
      });
    });
  }

  close(): void {
    try { this.ws.close(1000); } catch { /* ignore */ }
  }
}

function fail(msg: string): never {
  console.error('✗', msg);
  process.exit(1);
}
function ok(msg: string): void { console.log('✔', msg); }

/** Wait until `pred` has matched `n` distinct received messages. */
function waitForCount(c: ChatClient, pred: (m: ServerMsg) => boolean, n: number, timeoutMs: number): Promise<void> {
  let already = c.received.filter(pred).length;
  if (already >= n) return Promise.resolve();
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`count timeout (got ${already}/${n})`)), timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const m = JSON.parse(ev.data as string) as ServerMsg;
      if (pred(m)) already++;
      if (already >= n) {
        clearTimeout(timer);
        c.ws.removeEventListener('message', onMessage as EventListener);
        res();
      }
    };
    c.ws.addEventListener('message', onMessage as EventListener);
  });
}

async function main(): Promise<void> {
  // ---------- pass 1: login alice + send 3 messages ----------
  console.log('— pass 1: login + send —');
  const a = new ChatClient(URL_ARG);
  await a.open();
  a.send({ type: 'login', username: 'alice', password: 'wonderland' });

  const li = await a.await((m) => m.type === 'logged-in' || m.type === 'login-failed');
  if (li.type !== 'logged-in') fail(`login-failed: ${(li as ServerMsg).reason}`);
  ok('logged in as alice');

  await a.await((m) => m.type === 'rooms');
  ok('received rooms list');

  // Synchronization point: wait until we've seen `users` AND
  // `history` for #general — that confirms our subscribe was
  // processed AND the sharded ChatRoomActor responded.  The
  // history reply comes back through the cross-node ActorRef
  // mechanism, so receiving it also tells us cross-node routing
  // is healthy.  By this time the pubsub-mediator has had ample
  // gossip cycles to know about our subscribe on every node.
  await a.await((m) => m.type === 'users' && (m as ServerMsg).room === 'general', 5000);
  await a.await((m) => m.type === 'history' && (m as ServerMsg).room === 'general', 5000);
  // One extra anti-jitter sleep — eagerGossip is fire-and-forget;
  // give a margin before the first send to make sure the publish
  // path knows about our subscriber on whichever node hosts the
  // shard.
  await new Promise((r) => setTimeout(r, 750));

  for (const text of ['hello world', 'second msg', 'third msg']) {
    a.send({ type: 'send', room: 'general', text });
  }

  // Wait for the 3 broadcast echoes.  Single-node cluster needs a
  // moment for self-up + shard-allocation before the first message
  // fully propagates.
  await waitForCount(a, (m) =>
    m.type === 'message' &&
    (m as ServerMsg).room === 'general' &&
    ((m as ServerMsg).from as string) === 'alice', 3, 10_000,
  );
  ok('received 3 broadcast echoes');

  a.close();
  await new Promise((r) => setTimeout(r, 200));

  // ---------- pass 2: bob logs in, expects history ----------
  console.log('— pass 2: history replay —');
  const b = new ChatClient(URL_ARG);
  await b.open();
  b.send({ type: 'login', username: 'bob', password: 'builder' });
  const bli = await b.await((m) => m.type === 'logged-in' || m.type === 'login-failed');
  if (bli.type !== 'logged-in') fail(`bob login-failed`);
  ok('logged in as bob');

  const hist = (await b.await(
    (m) => m.type === 'history' && (m as ServerMsg).room === 'general',
  )) as ServerMsg & { messages: Array<{ from: string; text: string }> };
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
  a2.send({ type: 'login', username: 'alice', password: 'wonderland' });
  b2.send({ type: 'login', username: 'bob',   password: 'builder' });
  await a2.await((m) => m.type === 'logged-in');
  await b2.await((m) => m.type === 'logged-in');

  // Wait for both clients to receive the initial `rooms` frame so
  // we know each has subscribed to the directory before alice asks
  // for the create — otherwise bob might miss the broadcast.
  await a2.await((m) => m.type === 'rooms');
  await b2.await((m) => m.type === 'rooms');

  a2.send({ type: 'create-room', name: roomName });

  // Both clients should see `room-added` with the new name.
  await a2.await((m) => m.type === 'room-added' && (m as ServerMsg).name === roomName, 5000);
  await b2.await((m) => m.type === 'room-added' && (m as ServerMsg).name === roomName, 5000);
  ok(`both clients saw room-added(${roomName})`);

  // Both join the new room and round-trip a message.
  a2.send({ type: 'join', room: roomName });
  b2.send({ type: 'join', room: roomName });
  // Give the subscriptions a gossip tick — same anti-jitter margin
  // we use in pass 1 before the first send.
  await new Promise((r) => setTimeout(r, 750));
  a2.send({ type: 'send', room: roomName, text: 'hi from alice in new room' });
  await b2.await(
    (m) => m.type === 'message'
        && (m as ServerMsg).room === roomName
        && (m as ServerMsg).from === 'alice',
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
  a3.send({ type: 'login', username: 'alice', password: 'wonderland' });
  b3.send({ type: 'login', username: 'bob',   password: 'builder' });
  await a3.await((m) => m.type === 'logged-in');
  await b3.await((m) => m.type === 'logged-in');
  // Anti-jitter: give both sides a moment to subscribe to their DM
  // inbox topics before the first DM is sent.  Inbox subscriptions
  // happen during `activate()` after `logged-in` — usually instant,
  // but the gossip-driven mediator may take a tick to propagate.
  await new Promise((r) => setTimeout(r, 750));

  // alice DMs bob.
  a3.send({ type: 'send', room: '@bob', text: 'private hi from alice' });
  // alice should see her own outgoing DM via her inbox subscription —
  // the channel actor publishes to both participants.
  await a3.await(
    (m) => m.type === 'message'
        && (m as ServerMsg).room === '@bob'
        && (m as ServerMsg).from === 'alice'
        && (m as ServerMsg).text === 'private hi from alice',
    5000,
  );
  // bob receives it as `@alice` (his side renders the other party).
  await b3.await(
    (m) => m.type === 'message'
        && (m as ServerMsg).room === '@alice'
        && (m as ServerMsg).from === 'alice'
        && (m as ServerMsg).text === 'private hi from alice',
    5000,
  );
  ok('alice→bob DM delivered to both sides');

  // bob replies; same round-trip in the other direction.
  b3.send({ type: 'send', room: '@alice', text: 'private hi from bob' });
  await a3.await(
    (m) => m.type === 'message'
        && (m as ServerMsg).room === '@bob'
        && (m as ServerMsg).from === 'bob'
        && (m as ServerMsg).text === 'private hi from bob',
    5000,
  );
  ok('bob→alice DM delivered');

  // History request: bob "joins" `@alice` and expects to see the
  // two messages he just took part in.
  b3.send({ type: 'join', room: '@alice' });
  const dmHist = (await b3.await(
    (m) => m.type === 'history' && (m as ServerMsg).room === '@alice',
    5000,
  )) as ServerMsg & { messages: Array<{ from: string; text: string }> };
  if (!Array.isArray(dmHist.messages) || dmHist.messages.length < 2) {
    fail(`DM history too short: ${JSON.stringify(dmHist.messages)}`);
  }
  ok(`DM history has ${dmHist.messages.length} messages`);

  a3.close(); b3.close();
  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
}

main().catch((e) => fail((e as Error).message));
