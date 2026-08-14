/**
 * Smoke case: the HttpClient redirect policy is real on whichever runtime is
 * running — a chain is followed and bounded, and `'error'` never lets the
 * nominated host be contacted at all (#625).
 *
 * Runtime-sensitive for one specific reason.  Bounding a chain, stripping
 * credentials on a cross-origin hop and refusing a non-HTTP(S) target all
 * require the client to follow the chain ITSELF, which means asking `fetch`
 * for `redirect: 'manual'` and reading `Location` back off the 3xx.  That is
 * the corner of the Fetch spec where server runtimes deliberately deviate
 * from browsers — a browser answers a manual redirect with an opaque
 * response whose status is 0 and whose headers are empty, and a runtime that
 * did the same here would turn every redirect into a silent, unfollowable
 * dead end.  Bun, Node/undici and Deno each decided that separately.
 *
 * The bun-test suite proves the policy on Bun only; this proves the primitive
 * it stands on exists on all three.
 */
export const name = 'http client redirects';
export const description = 'a redirect chain is followed and bounded, and refusing one means never contacting the target';

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HttpClient, HttpRedirectError, completeText, concat, get, path, redirect } = await loadEntry('http');

  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-http-client-redirects', systemOptions);
  let binding;
  // Counted rather than inferred: "the target was never contacted" is the
  // whole claim, and it cannot be read off the response.
  let endHits = 0;
  try {
    const routes = concat(
      path('start', get(() => redirect('/end'))),
      path('loop', get(() => redirect('/loop'))),
      path('end', get(() => { endHits++; return completeText(200, 'arrived'); })),
    );
    try {
      binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    } catch (e) {
      console.log(`  (skipped: could not bind an HTTP server on this runtime — ${e.message})`);
      return;
    }
    const base = `http://127.0.0.1:${binding.port}`;

    // Following works, and the response says which hop actually answered —
    // the assertion that fails on a runtime returning an opaque 3xx.
    const followed = await new HttpClient().get(`${base}/start`);
    assert(followed.status === 200, `a followed redirect ended on HTTP ${followed.status}`);
    assert(followed.text() === 'arrived', `a followed redirect returned ${JSON.stringify(followed.text())}`);
    assert(followed.url === `${base}/end`, `the response names the wrong final hop: ${followed.url}`);
    assert(endHits === 1, `expected exactly one hit on /end, saw ${endHits}`);

    // Refusing means refusing before the hop, not after it.
    const refused = await failureOf(() => new HttpClient({ redirect: 'error' }).get(`${base}/start`));
    assert(refused !== undefined, "redirect: 'error' followed the redirect anyway");
    assert(
      refused instanceof HttpRedirectError,
      `a refused redirect failed with the wrong error: ${refused && refused.message}`,
    );
    assert(endHits === 1, `redirect: 'error' still contacted the target (${endHits} hits on /end)`);

    // The 3xx itself stays readable in manual mode — the primitive this whole
    // design rests on, and the one that differs most across runtimes.
    const manual = await new HttpClient({ redirect: 'manual' }).get(`${base}/start`);
    assert(manual.status === 302, `manual mode returned HTTP ${manual.status}, expected 302`);
    assert(manual.headers.location === '/end', `manual mode lost the Location header: ${manual.headers.location}`);
    assert(endHits === 1, `manual mode still contacted the target (${endHits} hits on /end)`);

    // An endless chain terminates on the budget rather than on the platform's.
    const looped = await failureOf(() => new HttpClient({ maxRedirects: 3 }).get(`${base}/loop`));
    assert(
      looped instanceof HttpRedirectError,
      `an endless redirect chain failed with the wrong error: ${looped && looped.message}`,
    );
    assert(looped.hops === 3, `the chain stopped after ${looped.hops} hops, expected 3`);
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
