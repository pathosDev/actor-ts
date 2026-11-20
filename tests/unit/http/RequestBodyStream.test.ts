import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  declaredBodyLength,
  limitedRequestBody,
  nodeRequestBodySource,
  remainderForcesClose,
  type RequestBodySource,
  webRequestBodySource,
} from '../../../src/http/backend/RequestBodyStream.js';
import { STREAMED_BODY_DRAIN_LIMIT_BYTES } from '../../../src/http/Constants.js';
import { HttpError, RequestBodyAbortedError, RequestBodyTooLargeError, Status } from '../../../src/http/Types.js';

/** A source over fixed chunks that records how many reads it served. */
function scriptedSource(chunks: ReadonlyArray<Uint8Array | Error>): RequestBodySource & { reads: number; stopped: boolean } {
  const queue = [...chunks];
  const source = {
    reads: 0,
    stopped: false,
    read: async (): Promise<Uint8Array | null> => {
      source.reads += 1;
      const next = queue.shift();
      if (next === undefined) return null;
      if (next instanceof Error) throw next;
      return next;
    },
    stop: (): void => { source.stopped = true; },
  };
  return source;
}

const bytes = (length: number, fill = 1): Uint8Array => new Uint8Array(length).fill(fill);

async function readAll(body: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) total += chunk.byteLength;
  return total;
}

describe('limitedRequestBody', () => {
  test('reads nothing before the consumer asks — the high-water mark is zero', async () => {
    const source = scriptedSource([bytes(10), bytes(10)]);
    const { body, progress } = limitedRequestBody(source, { maxBytes: 100 });
    // An absence — no read before the consumer asks — cannot be polled for.
    await Bun.sleep(5);
    expect(source.reads).toBe(0);
    expect(progress.state).toBe('unread');

    const reader = body.getReader();
    await reader.read();
    // An absence again: no read ahead of the one asked for.
    await Bun.sleep(5);
    // One read per chunk asked for, and not one ahead of it.
    expect(source.reads).toBe(1);
    expect(progress).toEqual({ state: 'reading', bytesRead: 10 });
  });

  test('yields every chunk and ends', async () => {
    const source = scriptedSource([bytes(3), bytes(0), bytes(4)]);
    const { body, progress } = limitedRequestBody(source, { maxBytes: 7, declaredLength: 7 });
    expect(await readAll(body)).toBe(7);
    expect(progress).toEqual({ state: 'ended', bytesRead: 7 });
  });

  test('calls onFirstPull once, at the first read', async () => {
    let pulls = 0;
    const { body } = limitedRequestBody(scriptedSource([bytes(1), bytes(1)]), { maxBytes: 10, onFirstPull: () => { pulls += 1; } });
    expect(pulls).toBe(0);
    await readAll(body);
    expect(pulls).toBe(1);
  });

  test('errors with RequestBodyTooLargeError on the chunk that crosses the limit, and never yields it', async () => {
    const source = scriptedSource([bytes(6), bytes(6)]);
    const { body, progress } = limitedRequestBody(source, { maxBytes: 10 });
    const reader = body.getReader();
    expect((await reader.read()).value?.byteLength).toBe(6);
    const failure = await reader.read().then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(RequestBodyTooLargeError);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(Status.PayloadTooLarge);
    expect((failure as RequestBodyTooLargeError).maxBytes).toBe(10);
    expect(progress.state).toBe('over-limit');
    expect(source.stopped).toBe(true);
  });

  test('a body exactly at the limit is accepted', async () => {
    const { body, progress } = limitedRequestBody(scriptedSource([bytes(5), bytes(5)]), { maxBytes: 10 });
    expect(await readAll(body)).toBe(10);
    expect(progress.state).toBe('ended');
  });

  test('a failing source errors the stream with RequestBodyAbortedError', async () => {
    const cause = new Error('socket hang up');
    const { body, progress } = limitedRequestBody(scriptedSource([bytes(2), cause]), { maxBytes: 10 });
    const failure = await readAll(body).then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(RequestBodyAbortedError);
    expect((failure as { cause?: unknown }).cause).toBe(cause);
    expect(progress.state).toBe('aborted');
  });

  test('a body that ends short of its declared length was cut off — aborted', async () => {
    const { body, progress } = limitedRequestBody(scriptedSource([bytes(4)]), { maxBytes: 100, declaredLength: 10 });
    const failure = await readAll(body).then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(RequestBodyAbortedError);
    expect(progress.state).toBe('aborted');
  });

  test('cancelling marks the body cancelled and stops the source', async () => {
    const source = scriptedSource([bytes(4), bytes(4)]);
    const { body, progress } = limitedRequestBody(source, { maxBytes: 100 });
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    expect(progress.state).toBe('cancelled');
    expect(source.stopped).toBe(true);
  });
});

describe('remainderForcesClose', () => {
  test('a body read to its end keeps the connection', () => {
    expect(remainderForcesClose({ state: 'ended', bytesRead: 10 }, undefined)).toBe(false);
  });

  test.each(['over-limit', 'aborted', 'cancelled'] as const)('a %s body closes it', (state) => {
    expect(remainderForcesClose({ state, bytesRead: 0 }, 0)).toBe(true);
  });

  test('a declared remainder up to the drain limit is drained, one byte more closes', () => {
    const limit = STREAMED_BODY_DRAIN_LIMIT_BYTES;
    expect(remainderForcesClose({ state: 'unread', bytesRead: 0 }, limit)).toBe(false);
    expect(remainderForcesClose({ state: 'unread', bytesRead: 0 }, limit + 1)).toBe(true);
    expect(remainderForcesClose({ state: 'reading', bytesRead: 10 }, limit + 10)).toBe(false);
    expect(remainderForcesClose({ state: 'reading', bytesRead: 10 }, limit + 11)).toBe(true);
  });

  test('an unknown remainder — a chunked body — always closes', () => {
    expect(remainderForcesClose({ state: 'unread', bytesRead: 0 }, undefined)).toBe(true);
  });
});

describe('declaredBodyLength', () => {
  test('reads Content-Length', () => {
    expect(declaredBodyLength({ 'content-length': '42' }, false)).toBe(42);
  });
  test('an HTTP/1.1 request with neither header has no body', () => {
    expect(declaredBodyLength({}, false)).toBe(0);
  });
  test('a chunked or HTTP/2 request without Content-Length has an unknown length', () => {
    expect(declaredBodyLength({ 'transfer-encoding': 'chunked' }, false)).toBeUndefined();
    expect(declaredBodyLength({}, true)).toBeUndefined();
  });
  test('a malformed Content-Length is unknown, not zero', () => {
    expect(declaredBodyLength({ 'content-length': 'many' }, false)).toBeUndefined();
    expect(declaredBodyLength({ 'content-length': '-1' }, false)).toBeUndefined();
  });
});

describe('nodeRequestBodySource', () => {
  test('reads in paused mode — the stream is not consumed until asked', async () => {
    const request = new PassThrough({ highWaterMark: 16 });
    const source = nodeRequestBodySource(request);
    request.write(bytes(8));
    request.write(bytes(8));
    request.write(bytes(8));
    // Lets any flowing-mode consumer run; there must be none.
    await Bun.sleep(5);
    // Nothing drained it: the readable side holds no more than its
    // high-water mark, and the rest waits upstream — the backpressure a
    // socket would feel.
    expect(request.readableLength).toBeLessThanOrEqual(16);
    request.end();
    let total = 0;
    for (let chunk = await source.read(); chunk !== null; chunk = await source.read()) total += chunk.byteLength;
    expect(total).toBe(24);
  });

  test('a request closed before its end rejects with RequestBodyAbortedError', async () => {
    const request = new PassThrough();
    const source = nodeRequestBodySource(request);
    const pending = source.read().then(() => null, (err: unknown) => err);
    request.destroy();
    expect(await pending).toBeInstanceOf(RequestBodyAbortedError);
  });

  test('an erroring request rejects with RequestBodyAbortedError carrying the cause', async () => {
    const request = new PassThrough();
    const source = nodeRequestBodySource(request);
    const pending = source.read().then(() => null, (err: unknown) => err);
    const cause = new Error('ECONNRESET');
    request.destroy(cause);
    const failure = await pending;
    expect(failure).toBeInstanceOf(RequestBodyAbortedError);
    expect((failure as { cause?: unknown }).cause).toBe(cause);
  });

  test('stop detaches the listeners', () => {
    const request = new PassThrough();
    const source = nodeRequestBodySource(request);
    expect(request.listenerCount('readable')).toBe(1);
    source.stop();
    expect(request.listenerCount('readable')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
  });
});

describe('webRequestBodySource', () => {
  test('reads chunks and ends', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes(3)); controller.close(); },
    });
    const source = webRequestBodySource(stream);
    expect((await source.read())?.byteLength).toBe(3);
    expect(await source.read()).toBeNull();
  });

  test('a failing stream rejects with RequestBodyAbortedError', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('reset')); } });
    const failure = await webRequestBodySource(stream).read().then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(RequestBodyAbortedError);
  });

  test('stop cancels the stream and further reads end', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull() { /* never */ }, cancel() { cancelled = true; } });
    const source = webRequestBodySource(stream);
    source.stop();
    // reader.cancel() settles the source's cancel on a later turn.
    await Bun.sleep(1);
    expect(cancelled).toBe(true);
    expect(await source.read()).toBeNull();
  });
});
