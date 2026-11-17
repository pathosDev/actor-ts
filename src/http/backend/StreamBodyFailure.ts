/**
 * The part of the `setStreamFailureHandler` contract the Fetch-shaped
 * backends share (#1829, #1830): a `ReadableStream` body that is handed to a
 * runtime or framework which pulls it on its own schedule, re-wrapped so a
 * source failure is still seen by the backend that handed it over.
 *
 * `ExpressBackend` pipes into a `node:http` response itself and keeps its own
 * generator; Fastify and Hono only ever see a stream they give away, so the
 * failure has to be observed inside the stream.
 */

/** What one `read()` of a stream body's reader settles with — named off the reader, whichever lib spells it. */
type ChunkReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/**
 * A stream that yields `first` (when given) and then everything `reader`
 * still produces, and calls `onSourceFailure` once when a read of the source
 * rejects, before passing the rejection on — so the consumer still ends the
 * response the way it ends any failed body, by truncating it.
 *
 * Pull-driven with a high-water mark of zero: nothing is read from the source
 * ahead of the consumer, so a slow source is not drained into memory and a
 * consumer that stops pulling stops the source.  A consumer that cancels — a
 * client gone mid-body — cancels the source, which is what releases whatever
 * it reads from; that is not a failure of the source and is not reported.
 */
export function reportingSourceFailure(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onSourceFailure: (err: unknown) => void,
  first?: Uint8Array,
): ReadableStream<Uint8Array> {
  let pending = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending !== undefined) {
        const chunk = pending;
        pending = undefined;
        controller.enqueue(chunk);
        return;
      }
      let next: ChunkReadResult;
      try {
        next = await reader.read();
      } catch (err) {
        onSourceFailure(err);
        controller.error(err);
        return;
      }
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => { /* the source failed while cancelling */ });
    },
  }, { highWaterMark: 0 });
}

/**
 * Read the first chunk of a stream body before anything is committed, because
 * until then the status is still open: a source that fails here rejects, and
 * the caller hands the failure to the error handler like any other.
 *
 * A client that disconnects while the first chunk is outstanding aborts
 * `signal`, and the source is cancelled then — nothing else would, since no
 * response holds the stream yet.
 */
export async function readFirstChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ChunkReadResult> {
  const cancelOnAbort = (): void => { reader.cancel().catch(() => { /* already settled */ }); };
  if (signal?.aborted === true) cancelOnAbort();
  else signal?.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    return await reader.read();
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
  }
}
