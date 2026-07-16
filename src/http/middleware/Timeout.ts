/**
 * Request-timeout middleware.  Races the handler against a deadline and
 * returns 503 if it wins.
 *
 * Honest limitation: the handler is NOT cancelled — it keeps running, and
 * its late result is discarded.  This bounds client-observed latency and
 * how long a response is held open, nothing more.
 */
import type { Middleware } from '../Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../types.js';
import { TimeoutOptionsValidator, type TimeoutOptions, type TimeoutOptionsType } from './TimeoutOptions.js';

/** Build a middleware that bounds handler latency.  Accepts a bare ms number or options. */
export function requestTimeout(options: number | TimeoutOptions): Middleware {
  const resolvedOptions = typeof options === 'number' ? { ms: options } : (options as Partial<TimeoutOptionsType>);
  new TimeoutOptionsValidator().validate(resolvedOptions);
  const ms = resolvedOptions.ms ?? 30_000;
  const onTimeout = resolvedOptions.onTimeout
    ?? ((): HttpResponse => ({ status: Status.ServiceUnavailable, body: { error: 'request timed out' } }));

  return async (request: HttpRequest, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve(next());
    // If the timeout wins, the handler may still reject later — swallow it
    // here so it doesn't surface as an unhandled rejection.
    work.catch(() => { /* discarded — timeout already answered */ });
    const timeout = new Promise<HttpResponse>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout(request)), ms);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
