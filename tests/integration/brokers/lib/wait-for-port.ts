/**
 * Polls a TCP port until it accepts a connection or a deadline elapses.
 *
 * Every live-integration broker suite has the same setup-time shape:
 * `docker compose up -d <broker>` returns IMMEDIATELY but the broker
 * itself may need ~1-30 seconds to be ready (Kafka brokers, RabbitMQ
 * — the slow ones; MinIO, Redis — fast).  Trying to connect before
 * the broker is listening produces a flaky ECONNREFUSED race that
 * shows up as 10% of CI runs failing on the first scenario.
 *
 * This helper polls `host:port` with a TCP socket connect; success
 * returns immediately, failure retries with a small backoff until
 * the deadline.  The deadline is loud — the final error names the
 * host:port and the elapsed time so a misconfigured compose file
 * doesn't hang silently for 30s.
 *
 * Use it from every broker scenario's `beforeAll` / setup function:
 *
 *   await waitForPort('localhost', 9000, { description: 'MinIO API' });
 */
import { connect } from 'node:net';

export interface WaitForPortOptions {
  /** Total time allowed to wait (default 30s — covers Kafka boot). */
  readonly deadlineMs?: number;
  /** Sleep between connection attempts (default 250ms). */
  readonly intervalMs?: number;
  /** Friendly description for the error message ("MinIO API", "Kafka broker"). */
  readonly description?: string;
}

/**
 * Resolve once `host:port` accepts a TCP connection.  Rejects with a
 * descriptive error if the deadline elapses without the port ever
 * opening.
 *
 * Implementation note: `node:net.connect` works on Bun too — it's the
 * universal cross-runtime way to test a TCP listener.  We deliberately
 * don't use HTTP probes here because not every broker speaks HTTP
 * (Kafka, NATS, MQTT, AMQP all use bespoke binary protocols).  A raw
 * TCP-connect succeeds as soon as the broker's accept loop is up,
 * which is the right granularity for "broker is ready to be talked to".
 */
export function waitForPort(
  host: string,
  port: number,
  options: WaitForPortOptions = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const description = options.description ?? `${host}:${port}`;
  const start = Date.now();
  const deadline = start + deadlineMs;

  return new Promise<void>((resolve, reject) => {
    const attempt = (): void => {
      const sock = connect({ host, port });
      let settled = false;
      const finishOk = (): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve();
      };
      const finishErr = (): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(
            `waitForPort: ${description} (${host}:${port}) not open after ` +
            `${Math.round((Date.now() - start) / 1000)}s — last attempt failed`,
          ));
          return;
        }
        setTimeout(attempt, intervalMs);
      };
      sock.once('connect', finishOk);
      sock.once('error', finishErr);
      // Per-attempt timeout — most brokers either accept immediately
      // or refuse immediately.  A hanging attempt usually means a
      // half-open routing config; bail and retry rather than block.
      sock.setTimeout(Math.min(intervalMs * 4, 2_000), finishErr);
    };
    attempt();
  });
}

/**
 * Convenience wrapper that polls an HTTP endpoint for a 2xx/3xx
 * response.  Used by brokers that have a separate readiness URL
 * (MinIO `/minio/health/live`, RabbitMQ `/api/healthchecks/node`).
 * Falls back to `waitForPort` semantics when the URL is unreachable.
 */
export async function waitForHttp(
  url: string,
  options: WaitForPortOptions = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const description = options.description ?? url;
  const start = Date.now();
  const deadline = start + deadlineMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 400) return;
    } catch {
      // Swallow — broker not ready yet.  Retry below.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForHttp: ${description} (${url}) did not return < 400 within ` +
    `${Math.round((Date.now() - start) / 1000)}s`,
  );
}
