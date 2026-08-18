/**
 * At-least-once, proven against a real server: a target that never
 * acknowledges must see the same message again.
 *
 * The redelivery is observed across a restart rather than within one
 * bridge — that is the case that matters (a crashed consumer), and it
 * cannot be satisfied by anything the process kept in memory. Once a
 * later bridge does acknowledge, the message must stop coming back.
 */
import { spawnBridge, type EmailContext } from '../Runner.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';

export const scenario: BrokerScenario<EmailContext> = {
  name: 'an unacknowledged message survives a restart and is redelivered',
  async run(context) {
    const tag = `redelivery-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // First bridge: receives, never answers.
    const silent = spawnBridge(context, { mode: 'silent' });
    let messageId: string;
    try {
      silent.bridge.tell({ kind: 'send', email: { to: context.address, subject: tag, text: tag } });
      await waitFor(`message ${tag} reached the silent consumer`,
        () => silent.inbox.received.some((m) => m.subject === tag),
        30_000,
      );
      messageId = silent.inbox.received.find((m) => m.subject === tag)!.messageId!;
    } finally {
      silent.stop();
    }
    await new Promise((r) => setTimeout(r, 500));

    // Second bridge: the message was never settled, so it must come back.
    const acknowledging = spawnBridge(context);
    try {
      await waitFor(`message ${messageId} was redelivered after the restart`,
        () => acknowledging.inbox.countOf(messageId) > 0,
        30_000,
      );
      await new Promise((r) => setTimeout(r, 1_000)); // let the STORE land
    } finally {
      acknowledging.stop();
    }
    await new Promise((r) => setTimeout(r, 500));

    // Third bridge: now that it was acknowledged, it must stay gone.
    const verifier = spawnBridge(context);
    try {
      await new Promise((r) => setTimeout(r, 4_000));
      if (verifier.inbox.countOf(messageId) > 0) {
        throw new Error(`message ${messageId} came back after being acknowledged`);
      }
    } finally {
      verifier.stop();
    }
  },
};
