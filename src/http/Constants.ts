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
