/**
 * Request-timeout middleware.  Races the handler against a deadline and
 * returns 503 if it wins.
 *
 * Honest limitation: the handler is NOT cancelled — it keeps running, and
 * its late result is discarded.  This bounds client-observed latency and
 * how long a response is held open, nothing more.
 */
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import { configAwareMiddleware, type Middleware } from '../Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../Types.js';
import {
  DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS,
  TimeoutOptionsValidator,
  type TimeoutOptions,
  type TimeoutOptionsType,
} from './TimeoutOptions.js';

/** The deadline and the answer a handler gets, merged and validated. */
type ResolvedRequestTimeout = {
  readonly deadlineMs: number;
  readonly onTimeout: (request: HttpRequest) => HttpResponse;
};

const serviceUnavailable = (): HttpResponse =>
  ({ status: Status.ServiceUnavailable, body: { error: 'request timed out' } });

/**
 * Merge request-timeout options over `actor-ts.http.request-timeout` and the
 * built-in defaults — options > HOCON > built-in, per field — and validate
 * the merged result once.  `config` is absent for a tree compiled without a
 * system, which gets the options over the built-in defaults.
 */
function resolveRequestTimeout(options: Partial<TimeoutOptionsType>, config: Config | undefined): ResolvedRequestTimeout {
  const resolved = mergeOptions<ResolvedRequestTimeout>(
    { deadlineMs: DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS, onTimeout: serviceUnavailable },
    config === undefined ? {} : readRequestTimeoutOptionsFromConfig(config),
    options,
  );
  new TimeoutOptionsValidator().validate(resolved);
  return resolved;
}

/**
 * The `actor-ts.http.request-timeout` layer, as a partial — an unset leaf is
 * left out, so the layer below it is reached rather than shadowed.
 *
 * `deadline` is read with `getDuration`, so `30s` and a bare millisecond
 * count both work, and left to {@link TimeoutOptionsValidator} on the merged
 * result — which is where a deadline longer than a timer can hold is refused.
 * `onTimeout` has no leaf: it is a function.
 */
export function readRequestTimeoutOptionsFromConfig(config: Config): Partial<TimeoutOptionsType> {
  const keys = ConfigKeys.http.requestTimeout;
  if (!config.hasPath(keys.root)) return {};
  const out: { -readonly [K in keyof TimeoutOptionsType]: TimeoutOptionsType[K] } = {};
  if (config.hasPath(keys.deadline)) out.deadlineMs = config.getDuration(keys.deadline);
  return out;
}

/**
 * Build a middleware that bounds handler latency.  Accepts the deadline in
 * milliseconds as a bare number, options, or nothing at all.
 *
 * The deadline is the options' over `actor-ts.http.request-timeout` over the
 * built-in 30 s (#1463).  The options are taken now; the configuration and the
 * validation of the merged deadline wait for the route tree to be compiled —
 * inside `bind()`, which is where an invalid deadline fails.
 */
export function requestTimeout(options: number | TimeoutOptions = {}): Middleware {
  // A snapshot: a builder is its settings and stays mutable, and a later
  // `withX` on it must not reach a middleware it was already handed to.
  const routeOptions: Partial<TimeoutOptionsType> = typeof options === 'number'
    ? { deadlineMs: options }
    : { ...(options as Partial<TimeoutOptionsType>) };
  return configAwareMiddleware(ConfigKeys.http.requestTimeout.root, (config) =>
    raceAgainstDeadline(resolveRequestTimeout(routeOptions, config)));
}

/** The middleware itself, for one resolved deadline. */
function raceAgainstDeadline({ deadlineMs, onTimeout }: ResolvedRequestTimeout): Middleware {
  return async (request: HttpRequest, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve(next());
    // If the timeout wins, the handler may still reject later — swallow it
    // here so it doesn't surface as an unhandled rejection.
    work.catch(() => { /* discarded — timeout already answered */ });
    const timeout = new Promise<HttpResponse>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout(request)), deadlineMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
