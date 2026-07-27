/**
 * Panel availability, resolved from the server handshake.
 *
 * Availability is decided by the SERVER, not the bundle: the UI ships
 * every panel, but whether one can do anything depends on the system it
 * is looking at (no cluster, no journal, tracing switched off).  The
 * server sends a status and a reason per panel, and both the nav rail
 * and the dashboard cards render from this one resolver so they can
 * never disagree.
 */
import type {
  DevToolsPanelDescriptor,
  DevToolsPanelId,
  WelcomeFrame,
} from '../../../src/devtools/protocol/index.js';

/** Descriptor for `panel`, or a "still connecting" placeholder. */
export function panelStatusOf(
  welcome: WelcomeFrame | null,
  panel: DevToolsPanelId,
): DevToolsPanelDescriptor {
  if (welcome === null) {
    return { id: panel, status: 'unavailable', reason: 'not connected' };
  }
  return welcome.panels.find((descriptor) => descriptor.id === panel)
    ?? { id: panel, status: 'unavailable', reason: 'not offered by this server' };
}

/** True when the panel can be opened. */
export function isPanelUsable(welcome: WelcomeFrame | null, panel: DevToolsPanelId): boolean {
  return panelStatusOf(welcome, panel).status === 'active';
}
