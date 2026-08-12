/**
 * Timestamp conversions the log wire formats need.
 *
 * Two of them — OTLP and Loki — want epoch **nanoseconds as a string**,
 * for the same reason, and getting it wrong fails in the same quiet way.
 */

/**
 * Milliseconds to a nanosecond string.
 *
 * Through `BigInt`, not `ms * 1e6`: epoch nanoseconds are around 1.8e18,
 * two orders of magnitude past `Number.MAX_SAFE_INTEGER`, so the double
 * cannot hold the product — for a timestamp in 2026 it lands 64 ns short.
 *
 * What makes that worth a comment is how well it hides.  `String()` prints
 * the shortest decimal that round-trips to the double, so the wrong number
 * still renders as the right-looking timestamp; the error only surfaces in
 * a consumer that compares nanosecond values, which is precisely what a
 * trace-to-log correlation does.
 *
 * A string rather than a number is also the wire requirement in both
 * protocols: proto3 JSON encodes 64-bit integers as strings, and Loki
 * answers a numeric timestamp with a 400.
 */
export function nanosecondsOf(timestampMs: number): string {
  return (BigInt(Math.trunc(timestampMs)) * 1_000_000n).toString();
}
