/**
 * End-to-end smoke test for the chat backend.
 *
 *   bun examples/chat/smoke-test.ts ws://127.0.0.1:8081/ws
 *
 * Verifies:
 *   1. Login flow via WS.
 *   2. Auto-join + initial rooms / users frames.
 *   3. Send → broadcast roundtrip.
 *   4. History persistence: new connection sees previous messages.
 *
 * Exit code 0 on success, non-zero on first failure.
 */

const URL_ARG = process.argv[2] ?? 'ws://127.0.0.1:8081/ws';

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

  // Brief settle: pubsub Subscribe propagates to remote mediators
  // via eagerGossip — on a fresh multi-node cluster the first send
  // can race ahead of that propagation.  500 ms is plenty.
  await new Promise((r) => setTimeout(r, 500));

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

  b.close();
  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
}

main().catch((e) => fail((e as Error).message));
