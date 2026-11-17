import { describe, expect, test } from 'bun:test';
import { readFirstChunk, reportingSourceFailure } from '../../../src/http/backend/StreamBodyFailure.js';

/** A source that counts how often it was asked for a chunk, and never runs dry. */
function countingSource(): { readonly body: ReadableStream<Uint8Array>; readonly reads: () => number } {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array([reads]));
    },
  }, { highWaterMark: 0 });
  return { body, reads: () => reads };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('reportingSourceFailure', () => {
  test('reads nothing from the source ahead of the consumer', async () => {
    const source = countingSource();
    const wrapped = reportingSourceFailure(source.body.getReader(), () => {});
    await settle();
    expect(source.reads()).toBe(0);

    const consumer = wrapped.getReader();
    await consumer.read();
    await consumer.read();
    await settle();
    expect(source.reads()).toBe(2);
  });

  test('a first chunk already read is served before the source is asked again', async () => {
    const source = countingSource();
    const wrapped = reportingSourceFailure(source.body.getReader(), () => {}, new Uint8Array([99]));
    await settle();
    expect(source.reads()).toBe(0);
    const first = await wrapped.getReader().read();
    expect(first.value).toEqual(new Uint8Array([99]));
    await settle();
    expect(source.reads()).toBe(0);
  });
});

describe('readFirstChunk', () => {
  test('a signal aborted before the read starts cancels the source', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => { /* the first chunk never arrives */ }); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    controller.abort();
    const first = await readFirstChunk(body.getReader(), controller.signal);
    expect(cancelled).toBe(true);
    expect(first.done).toBe(true);
  });
});
