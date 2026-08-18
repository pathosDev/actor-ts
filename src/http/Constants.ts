/**
 * Tuned values shared inside the HTTP subsystem that are not the built-in
 * default of a single options field (those live in the matching
 * `XOptions.ts`).
 *
 * This module imports nothing, so it can never close an import cycle.
 */

/**
 * Largest request body every shipped backend accepts before answering 413.
 *
 * It lives here rather than in `ExpressBackendOptions.ts` / `HonoBackendOptions.ts`
 * because it is the default of *three* backends, only two of which have an
 * options family — co-locating it would mean writing the number down three
 * times, which is how the caps drifted apart in the first place (#357): Express
 * and Hono each hardcoded 10 MiB while Fastify was left on its own 1 MiB
 * default, a 10x difference that changed with the backend rather than with
 * anything the application asked for.
 *
 * 1 MiB, i.e. the stricter of the two, because this is the number that applies
 * when nobody chose one: an unconfigured server should refuse a payload it has
 * no reason to expect, and raising the cap where a real upload endpoint needs
 * it is a deliberate, local act (`withMaxBodyBytes`, or Fastify's `bodyLimit`).
 * Raising the default backend to 10 MiB instead would have widened the
 * accept-anything window for every application that never made a choice.
 */
export const DEFAULT_HTTP_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Default cap on a single inbound WebSocket frame — 1 MiB.
 *
 * **Why this exists (security):** a malicious or compromised peer can send
 * arbitrarily-large frames.  Without a cap, a stalled downstream consumer plus
 * one 100-MiB frame exhausts the process.  The cap is enforced on the raw
 * frame *before* the codec decodes it.
 *
 * It lives here rather than in one options file because it is the fallback of
 * *two* separate options families — the server-side route policy
 * (`WebsocketPolicy`) and the client (`WebsocketClientOptions`).  No single
 * `XOptions.ts` owns both readers, and writing the number down per reader is
 * what let the transport side drift open in the first place.
 *
 * What a backend hands its runtime as the *transport* frame limit is derived
 * from the routes it registered, not from this constant: `transportFrameCapOf`
 * takes the widest cap any of them resolved to, so a route or a HOCON setting
 * that moves `maxFrameBytes` moves the buffering window with it (#373).  This
 * number is where that resolution starts when nothing else says otherwise, and
 * `transportFrameCapOf`'s own fallback for a server with no WebSocket routes.
 */
export const DEFAULT_WEBSOCKET_MAX_FRAME_BYTES = 1 * 1024 * 1024;

/**
 * Bytes a streamed static response reads per `pull` — 64 KiB.
 *
 * Not an option: it is the memory a streamed download costs, and the point of
 * streaming is that the number does not scale with the file.  Two chunks are
 * live at once (the queued one plus the one being read), so this is the whole
 * per-response cost regardless of whether the file is 1 MiB or 100 GiB.
 *
 * 64 KiB rather than something larger because it is already well past the
 * point where syscall overhead matters for sequential reads, and rather than
 * something smaller because a 4 KiB chunk turns a 1 GiB download into 262 144
 * round trips through the stream queue.  It lives here rather than in
 * `StaticFilesOptions.ts` because it is not the default of any options field —
 * `streamThreshold` decides *whether* a body streams; this decides how the
 * bytes are fetched once it does.
 */
export const STATIC_FILE_READ_CHUNK_BYTES = 64 * 1024;
