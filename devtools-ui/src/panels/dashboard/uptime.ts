/**
 * How long the system has been up, between samples.
 *
 * Its own module because it is the one figure on the overview the client
 * computes rather than receives, which makes it the one that can be
 * wrong on its own — worth testing without a DOM in the room.
 */
import type { WelcomeFrame } from '../../../../src/devtools/protocol/index.js';

/**
 * Server uptime plus the local time since we were told it.
 *
 * Reading the server's own figure rather than differencing wall clocks
 * keeps the tile right across a reload, a reconnect, and a browser whose
 * clock disagrees with the host's.
 */
export type UptimeAnchor = {
  readonly uptimeMs: number;
  readonly receivedAtMs: number;
};

/**
 * `nowMs` is the caller's idea of now, which is the wall clock while the
 * connection is up and the moment it dropped once it is not.  Every
 * other figure on the overview stops of its own accord when the samples
 * stop, because it is a number somebody sent us; this one is
 * interpolated, so it has to be told when to stand still.
 */
export function uptimeMillis(
  anchor: UptimeAnchor | null,
  welcome: WelcomeFrame | null,
  nowMs: number,
): number | null {
  if (anchor !== null) return anchor.uptimeMs + (nowMs - anchor.receivedAtMs);
  // Before the first sample the handshake is all we have.  It reports
  // the system's start, so this is right too — just clock-skewed on a
  // remote host.
  return welcome === null ? null : nowMs - welcome.startedAtMs;
}
