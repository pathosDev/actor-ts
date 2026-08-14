/**
 * Smoke case: the HttpClient response ceiling is a real bound on whichever
 * runtime is running, and a bodyless response still reads as empty (#602).
 *
 * Runtime-sensitive in the strict sense, and measurably so.  Enforcing the cap
 * means reading the body incrementally through `response.body.getReader()`
 * instead of letting `arrayBuffer()` allocate first and object later — and
 * `response.body` is the one part of `fetch` the three runtimes implement in
 * three separate stacks (Bun's own, undici on Node, Deno's Rust core).  They
 * disagree in exactly the place the rewrite is exposed: for a 204 and for a
 * HEAD, **Node and Deno hand back `body === null`, Bun hands back an empty
 * stream**.  So the `null` branch — whose absence turns every bodyless
 * response into a TypeError, which `arrayBuffer()` used to paper over — is
 * unreachable from the Bun-only unit suite, and this case is the only thing
 * that runs it at all.
 *
 * The chunk boundaries differ too (Bun coalesces a small body into one chunk
 * where undici yields one per write), so the reassembly path and the "refused
 * at the crossing chunk" path are likewise only covered on some runtimes here.
 */
export const name = 'http client response cap';
export const description = 'an over-cap body is refused mid-flight, an under-cap one reads back whole, and a 204 reads as empty';

/** Comfortably past the cap below, cheap to generate and to serve. */
const BIG_BODY = 'x'.repeat(256 * 1024);
const TINY_CAP_BYTES = 4096;

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HttpClient, HttpResponseTooLargeError, complete, completeText, concat, get, path } = await loadEntry('http');

  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-http-client-cap', systemOptions);
  let binding;
  try {
    const routes = concat(
      path('big', get(() => completeText(200, BIG_BODY))),
      path('small', get(() => completeText(200, 'hello'))),
      path('empty', get(() => complete(204))),
    );
    try {
      binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    } catch (e) {
      console.log(`  (skipped: could not bind an HTTP server on this runtime — ${e.message})`);
      return;
    }
    const base = `http://127.0.0.1:${binding.port}`;
    const client = new HttpClient({ maxResponseBytes: TINY_CAP_BYTES });

    const refused = await failureOf(() => client.get(`${base}/big`));
    assert(refused !== undefined, 'a body far over maxResponseBytes was buffered without complaint');
    assert(
      refused instanceof HttpResponseTooLargeError,
      `an over-cap body failed with the wrong error: ${refused && refused.message}`,
    );
    assert(
      refused.maxResponseBytes === TINY_CAP_BYTES,
      `the cap failure names the wrong bound: ${refused.maxResponseBytes}`,
    );

    // The cap is a bound, not a blanket refusal — the same body reads back
    // whole, byte for byte, once the bound admits it.
    const raised = await client.get(`${base}/big`, { maxResponseBytes: BIG_BODY.length + 1 });
    assert(raised.status === 200, `raising the per-request cap still failed: HTTP ${raised.status}`);
    assert(
      raised.body.byteLength === BIG_BODY.length,
      `the incremental read lost bytes: ${raised.body.byteLength} of ${BIG_BODY.length}`,
    );

    const small = await client.get(`${base}/small`);
    assert(small.text() === 'hello', `an under-cap body read back as ${JSON.stringify(small.text())}`);

    // The `response.body === null` branch — the one arrayBuffer() used to hide.
    const empty = await client.get(`${base}/empty`);
    assert(empty.status === 204, `expected 204, got ${empty.status}`);
    assert(empty.body.byteLength === 0, `a 204 carried ${empty.body.byteLength} bytes`);
  } finally {
    if (binding) await binding.unbind();
    await system.terminate();
  }
}

/** Run `attempt` and hand back the error it threw, or `undefined` when it succeeded. */
async function failureOf(attempt) {
  try {
    await attempt();
    return undefined;
  } catch (e) {
    return e;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
