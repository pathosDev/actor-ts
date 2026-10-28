/**
 * Smoke case: a request `HttpClient` cannot make propagates no part of the
 * credential in its URL, on whichever runtime is running (#1458).
 *
 * Runtime-sensitive because the error is the runtime's own, raised by its
 * `fetch` before any of this client's masking runs, and each runtime words it
 * differently.  Node refuses a URL with a userinfo outright: its `TypeError`
 * reads "Request cannot be constructed from a URL that includes credentials:"
 * followed by the URL, password and all.  Bun attempts the connection and,
 * when it is refused, hangs the URL on the error as its own `path` property.
 * Deno strips the userinfo itself.  The unit suite runs on Bun only, so it
 * cannot see Node's message at all.
 *
 * The request goes to a loopback port nothing listens on, so it fails on
 * every runtime — before a socket on Node, at once with a refused connection
 * on Bun and Deno — and opens nothing that outlives it.
 */
export const name = 'http client credentialed request';
export const description = 'a fetch that fails on a credentialed URL propagates no part of the credential';

export async function run({ loadEntry }) {
  const { HttpClient } = await loadEntry('http');
  const { createServer } = await import('node:net');

  // Bound, then released: a connection to it is refused rather than left to
  // time out.
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  let thrown = null;
  try {
    await new HttpClient({ defaultTimeoutMs: 4_000 }).get(`http://user:hunter2@127.0.0.1:${port}/start`);
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) throw new Error('a request to a released port succeeded');
  const readable = everyStringOf(thrown);
  if (readable.includes('hunter2')) {
    throw new Error(`the error HttpClient propagated names the password: ${JSON.stringify(readable.slice(0, 300))}`);
  }
  if (!(thrown instanceof Error)) throw new Error(`HttpClient propagated a non-Error: ${String(thrown)}`);
}

/** Message, stack, own string properties, `cause` and nested errors of `error`, joined. */
function everyStringOf(error, seen = new Set()) {
  if (!(error instanceof Error)) return String(error);
  if (seen.has(error)) return '';
  seen.add(error);
  const strings = [String(error.message), String(error.stack)];
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = error[key];
    if (typeof value === 'string') strings.push(value);
    else if (value instanceof Error) strings.push(everyStringOf(value, seen));
    else if (Array.isArray(value)) for (const element of value) strings.push(everyStringOf(element, seen));
  }
  return strings.join('\n');
}
