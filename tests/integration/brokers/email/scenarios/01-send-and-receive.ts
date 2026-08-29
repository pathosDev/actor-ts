/**
 * The full loop through a real mail server: the bridge's SMTP half posts a
 * message to its own address, GreenMail delivers it, the IMAP half picks it
 * up, and the target acknowledges — after which a fresh bridge must NOT see
 * it again, which is what proves the `\Seen` settle actually happened on the
 * server rather than only in memory.
 *
 * The body is rendered through `EmailTemplate`, so the escaping path ships
 * through a real SMTP/IMAP round-trip rather than only through unit tests.
 */
import { EmailTemplate } from '../../../../../src/io/broker/EmailTemplate.js';
import { spawnBridge, type EmailContext } from '../Runner.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';

export const scenario: BrokerScenario<EmailContext> = {
  name: 'send → deliver → acknowledge → not redelivered',
  async run(context) {
    const tag = `send-receive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const first = spawnBridge(context);
    try {
      const body = new EmailTemplate('<h1>{{title}}</h1><p>{{detail}}</p>')
        .setValue('title', tag)
        // Escaped on the way in, so it must arrive as text, not as markup.
        .setValue('detail', '<script>alert(1)</script>')
        .render();

      first.bridge.tell({
        kind: 'send',
        email: { to: context.address, subject: tag, html: body, text: tag },
      });

      await waitFor(`message ${tag} arrived over IMAP`,
        () => first.inbox.received.some((m) => m.subject === tag),
        30_000,
      );

      const received = first.inbox.received.find((m) => m.subject === tag)!;
      if (received.html === undefined || !received.html.includes('&lt;script&gt;')) {
        throw new Error(`expected the template to have escaped the value, got: ${received.html}`);
      }
      if (received.messageId === undefined) throw new Error('message arrived without a Message-ID');
      if (received.truncated) throw new Error('a short message must not be reported as truncated');

      // The acknowledgment is fire-and-forget, so give the STORE a moment
      // to reach the server before the next bridge asks what is unseen.
      await new Promise((r) => setTimeout(r, 1_000));
      const messageId = received.messageId;

      first.stop();
      await new Promise((r) => setTimeout(r, 500));

      // A brand-new bridge sweeps the same mailbox from scratch. The
      // acknowledged message is `\Seen`, so it must not come back.
      const second = spawnBridge(context);
      try {
        // Long enough for several sweeps of the fresh bridge.
        await new Promise((r) => setTimeout(r, 4_000));
        if (second.inbox.countOf(messageId) > 0) {
          throw new Error(`acknowledged message ${messageId} was redelivered to a fresh bridge`);
        }
      } finally {
        second.stop();
      }
    } finally {
      first.stop();
    }
  },
};
