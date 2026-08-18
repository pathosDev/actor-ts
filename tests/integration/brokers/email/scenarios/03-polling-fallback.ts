/**
 * The IDLE-less path against a real server.
 *
 * Plenty of IMAP servers either do not advertise IDLE or advertise it and
 * do not honour it, so `disableIdle` has to be a fully working mode rather
 * than a degraded one: the same send, the same delivery, the same settle —
 * just driven by the poll interval instead of a server notification.
 */
import { spawnBridge, type EmailContext } from '../Runner.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';

export const scenario: BrokerScenario<EmailContext> = {
  name: 'polling fallback delivers without IDLE',
  async run(context) {
    const tag = `polling-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bridge = spawnBridge(context, { imap: { disableIdle: true, pollIntervalMs: 500 } });
    try {
      bridge.bridge.tell({ kind: 'send', email: { to: context.address, subject: tag, text: tag } });

      await waitFor(`message ${tag} arrived on the polling path`,
        () => bridge.inbox.received.some((m) => m.subject === tag),
        30_000,
      );

      const received = bridge.inbox.received.find((m) => m.subject === tag)!;
      if (received.text === undefined || !received.text.includes(tag)) {
        throw new Error(`body did not survive the round-trip: ${received.text}`);
      }
    } finally {
      bridge.stop();
    }
  },
};
