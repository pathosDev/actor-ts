/**
 * `onProcessed: 'move'` against a real server.
 *
 * Two things are being proven, and the second is the reason the mode
 * exists: the destination mailbox is created by the bridge itself (a MOVE
 * into a mailbox that is not there fails, and a failed settle redelivers
 * forever), and a moved message is gone from the watched mailbox — which is
 * what a fresh bridge sweeping the same INBOX must confirm.
 */
import { spawnBridge, type EmailContext } from '../Runner.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';

export const scenario: BrokerScenario<EmailContext> = {
  name: 'move mode files the message away from the watched mailbox',
  async run(context) {
    const tag = `move-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // A fresh destination per run, so the create path is exercised rather
    // than a mailbox an earlier scenario left behind.
    const destination = `Processed-${Date.now()}`;

    const bridge = spawnBridge(context, {
      imap: { onProcessed: 'move', moveToMailbox: destination },
    });
    let messageId: string;
    try {
      bridge.bridge.tell({ kind: 'send', email: { to: context.address, subject: tag, text: tag } });

      await waitFor(`message ${tag} arrived before the move`,
        () => bridge.inbox.received.some((m) => m.subject === tag),
        30_000,
      );
      messageId = bridge.inbox.received.find((m) => m.subject === tag)!.messageId!;
      await new Promise((r) => setTimeout(r, 1_000)); // let the MOVE land
    } finally {
      bridge.stop();
    }
    await new Promise((r) => setTimeout(r, 500));

    // A fresh bridge on the default INBOX must not find it — in move mode
    // the sweep looks at everything present, so a message still there would
    // come straight back.
    const verifier = spawnBridge(context);
    try {
      await new Promise((r) => setTimeout(r, 4_000));
      if (verifier.inbox.countOf(messageId) > 0) {
        throw new Error(`message ${messageId} was still in INBOX after the move to ${destination}`);
      }
    } finally {
      verifier.stop();
    }
  },
};
