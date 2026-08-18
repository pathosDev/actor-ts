/**
 * Options for {@link EmailBridgeActor} — the IMAP-in / SMTP-out mail
 * bridge.  HOCON root: `actor-ts.io.broker.email-bridge`.
 *
 * The two sides are configured by two independent groups: `imap` gates
 * the inbound half, `smtp` the outbound half.  Either alone is a valid
 * bridge (an alert sink with no mailbox, or a mailbox reader that never
 * sends); the validator only insists that at least one is present.
 *
 * **Group defaults are applied at the use site, not here.**  `mergeOptions`
 * is a shallow top-level spread, so a nested group supplied by any layer
 * replaces the layer below it wholesale — a default `imap` object would
 * therefore be erased the moment a caller sets any `imap` field.  That is
 * why `builtInDefaultOptions()` returns `{}` and the actor reads every
 * group field as `?? DEFAULT_…`, the same way JetStream's consumer config
 * does.  The `DEFAULT_*` constants below are exported so those use sites,
 * the tests, and the documentation all quote one value.
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { EmailMessage } from './EmailBridgeActor.js';

/** Implicit-TLS IMAP port (RFC 8314 recommends it over STARTTLS on 143). */
export const DEFAULT_IMAP_PORT = 993;
/** The mailbox an IMAP session selects when none is named. */
export const DEFAULT_IMAP_MAILBOX = 'INBOX';
/**
 * How long one IDLE stretch may last before it is refreshed.  RFC 2177
 * tells clients to re-issue IDLE at least every 29 minutes; middleboxes
 * routinely cut idle TCP sooner, so 5 minutes is the safer default.
 */
export const DEFAULT_IMAP_MAX_IDLE_TIME_MS = 300_000;
/**
 * Upper bound on the time between two mailbox sweeps.  It is the polling
 * period when IDLE is unavailable, and a backstop when IDLE is in use —
 * which also bounds how long an unacknowledged message waits before it is
 * redelivered.
 */
export const DEFAULT_IMAP_POLL_INTERVAL_MS = 30_000;
/**
 * Cap on the decoded bytes taken from one message body part.  A mailbox is
 * untrusted input: anyone can send a multi-gigabyte mail, and without a cap
 * fetching it is the whole heap (the same posture as the SSE buffer cap,
 * security audit BRK-2).  Past the cap the part is cut and the delivered
 * message carries `truncated: true`.
 */
export const DEFAULT_EMAIL_MAX_MESSAGE_BYTES = 1_048_576;
/**
 * How long the bridge waits for the target actor's acknowledgment before it
 * gives the message up.  The message is then left unflagged, so the next
 * sweep redelivers it — the same "let it be redelivered" answer JetStream
 * gives a missing ack.
 */
export const DEFAULT_EMAIL_ACKNOWLEDGMENT_TIMEOUT_MS = 30_000;
/** Submission port (RFC 6409), i.e. STARTTLS rather than implicit TLS. */
export const DEFAULT_SMTP_PORT = 587;
/** Pooled SMTP connections kept warm. */
export const DEFAULT_SMTP_MAX_CONNECTIONS = 5;
/** Messages sent down one pooled connection before it is recycled. */
export const DEFAULT_SMTP_MAX_MESSAGES = 100;

/** What the bridge does to a message once the target actor acknowledged it. */
export type EmailProcessedAction = 'markSeen' | 'move';

/**
 * Inbound half — the IMAP mailbox the bridge watches.  Its presence is
 * what enables the inbound side at all.
 */
export type EmailImapOptionsType = {
  /** IMAP server hostname.  Required when this group is present. */
  readonly host?: string;
  /** IMAP port.  Default {@link DEFAULT_IMAP_PORT}. */
  readonly port?: number;
  /**
   * Implicit TLS from the first byte.  Default `true` (port 993).  `false`
   * starts in clear text and upgrades with STARTTLS — the 143 style.
   */
  readonly secure?: boolean;
  /** Login user. */
  readonly user?: string;
  /**
   * Login password.  A plain HOCON leaf, so keep it out of committed
   * config and substitute it from the environment:
   * `password = ${?ACTOR_TS_IMAP_PASSWORD}`.
   */
  readonly password?: string;
  /**
   * Mailbox to watch.  Default {@link DEFAULT_IMAP_MAILBOX}.  One actor
   * watches exactly one mailbox — an IMAP connection can IDLE only on the
   * mailbox it has selected, so watching two means spawning two actors.
   */
  readonly mailbox?: string;
  /**
   * How an acknowledged message is marked as done.  `'markSeen'` (default)
   * adds the `\Seen` flag and the sweep then skips it; `'move'` moves it to
   * {@link moveToMailbox} and the sweep no longer finds it.
   */
  readonly onProcessed?: EmailProcessedAction;
  /** Destination mailbox for `onProcessed: 'move'`.  Required in that mode. */
  readonly moveToMailbox?: string;
  /**
   * Never use IDLE, poll on {@link pollIntervalMs} instead.  The bridge
   * already falls back to polling when the server does not advertise IDLE;
   * this forces it for servers that advertise it but do not honour it.
   */
  readonly disableIdle?: boolean;
  /** Longest single IDLE stretch.  Default {@link DEFAULT_IMAP_MAX_IDLE_TIME_MS}. */
  readonly maxIdleTimeMs?: number;
  /** Longest gap between sweeps.  Default {@link DEFAULT_IMAP_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** Per-body-part byte cap.  Default {@link DEFAULT_EMAIL_MAX_MESSAGE_BYTES}. */
  readonly maxMessageBytes?: number;
  /** Acknowledgment deadline.  Default {@link DEFAULT_EMAIL_ACKNOWLEDGMENT_TIMEOUT_MS}. */
  readonly acknowledgmentTimeoutMs?: number;
};

/**
 * Outbound half — the pooled SMTP transport.  Its presence is what enables
 * the outbound side at all.
 */
export type EmailSmtpOptionsType = {
  /** SMTP server hostname.  Required when this group is present. */
  readonly host?: string;
  /** SMTP port.  Default {@link DEFAULT_SMTP_PORT}. */
  readonly port?: number;
  /**
   * Implicit TLS from the first byte (port 465).  Default `false`, which
   * is the submission-port style: connect in clear text, upgrade with
   * STARTTLS.
   */
  readonly secure?: boolean;
  /** Login user. */
  readonly user?: string;
  /** Login password — see {@link EmailImapOptionsType.password} on keeping it out of config. */
  readonly password?: string;
  /** Default `From` for messages that do not carry one. */
  readonly from?: string;
  /** Pooled connections kept warm.  Default {@link DEFAULT_SMTP_MAX_CONNECTIONS}. */
  readonly maxConnections?: number;
  /** Messages per connection before recycling.  Default {@link DEFAULT_SMTP_MAX_MESSAGES}. */
  readonly maxMessages?: number;
};

export interface EmailBridgeOptionsType extends BrokerCommonOptionsType {
  /** Inbound half.  Omit for a send-only bridge. */
  readonly imap?: EmailImapOptionsType;
  /** Outbound half.  Omit for a receive-only bridge. */
  readonly smtp?: EmailSmtpOptionsType;
  /**
   * Where inbound mail is delivered.  Required together with {@link imap}
   * and meaningless without it.
   *
   * Top-level rather than a field of the `imap` group on purpose: an
   * `ActorRef` can only come from code, the group's other fields are the
   * ones people set in HOCON, and the shallow group merge means mixing the
   * two in one object would make a code-set target erase the whole
   * configured group.
   */
  readonly target?: ActorRef<EmailMessage>;
}

export class EmailBridgeOptionsBuilder extends BrokerOptionsBuilder<EmailBridgeOptionsType> {
  /** Start a fresh builder.  Equivalent to `new EmailBridgeOptionsBuilder()`. */
  static create(): EmailBridgeOptionsBuilder {
    return new EmailBridgeOptionsBuilder();
  }

  /** Inbound half — the watched IMAP mailbox. */
  withImap(imap: EmailImapOptionsType): this {
    return this.set('imap', imap);
  }

  /** Outbound half — the pooled SMTP transport. */
  withSmtp(smtp: EmailSmtpOptionsType): this {
    return this.set('smtp', smtp);
  }

  /** Target actor for inbound mail. */
  withTarget(target: ActorRef<EmailMessage>): this {
    return this.set('target', target);
  }
}

/** Validates resolved {@link EmailBridgeOptionsType} settings. */
export class EmailBridgeOptionsValidator extends BrokerOptionsValidator<EmailBridgeOptionsType> {
  constructor() {
    super('EmailBridgeOptions');
  }

  protected rules(s: Partial<EmailBridgeOptionsType>): void {
    this.commonRules(s);

    // A bridge with neither half configured connects successfully and then
    // does nothing at all, forever — the least debuggable outcome there is.
    if (s.imap === undefined && s.smtp === undefined) {
      this.fail('imap/smtp', 'at least one side must be configured');
    }

    // Both directions: an inbound half with nowhere to deliver fetches mail
    // into the void, and a target with no mailbox is a ref nothing ever
    // reaches.  Either way the intent was not what was written down.
    if (s.imap !== undefined && s.target === undefined) {
      this.fail('target', 'is required when `imap` is configured (inbound mail needs a target actor)');
    }
    if (s.target !== undefined && s.imap === undefined) {
      this.fail('imap', 'is required when `target` is set (a target with no mailbox receives nothing)');
    }

    if (s.imap !== undefined) this.imapRules(s.imap);
    if (s.smtp !== undefined) this.smtpRules(s.smtp);
  }

  /*
   * The nested groups are checked imperatively: the field-name helpers
   * address top-level keys of the options type, and every field here is one
   * level down.  `fail` takes the dotted path so the message still names the
   * exact leaf.
   */

  private imapRules(imap: EmailImapOptionsType): void {
    if (imap.host === undefined || imap.host.length === 0) {
      this.fail('imap.host', 'must be a non-empty string', imap.host);
    }
    this.nestedPort('imap.port', imap.port);
    this.nestedPositive('imap.maxIdleTimeMs', imap.maxIdleTimeMs);
    this.nestedPositive('imap.pollIntervalMs', imap.pollIntervalMs);
    this.nestedPositive('imap.maxMessageBytes', imap.maxMessageBytes);
    this.nestedPositive('imap.acknowledgmentTimeoutMs', imap.acknowledgmentTimeoutMs);
    if (imap.mailbox !== undefined && imap.mailbox.length === 0) {
      this.fail('imap.mailbox', 'must be a non-empty string', imap.mailbox);
    }
    if (imap.onProcessed !== undefined && imap.onProcessed !== 'markSeen' && imap.onProcessed !== 'move') {
      this.fail('imap.onProcessed', 'must be one of "markSeen", "move"', imap.onProcessed);
    }
    if (imap.onProcessed === 'move') {
      if (imap.moveToMailbox === undefined || imap.moveToMailbox.length === 0) {
        this.fail('imap.moveToMailbox', 'is required when onProcessed is "move"', imap.moveToMailbox);
      }
      // Moving a message into the mailbox it is swept from settles nothing:
      // the next sweep finds it again, delivers it again, and the bridge
      // livelocks on one message.  Caught here because the move itself
      // succeeds — nothing downstream would ever report this as an error.
      const mailbox = imap.mailbox ?? DEFAULT_IMAP_MAILBOX;
      if (imap.moveToMailbox === mailbox) {
        this.fail('imap.moveToMailbox', 'must differ from the watched mailbox', imap.moveToMailbox);
      }
    }
  }

  private smtpRules(smtp: EmailSmtpOptionsType): void {
    if (smtp.host === undefined || smtp.host.length === 0) {
      this.fail('smtp.host', 'must be a non-empty string', smtp.host);
    }
    this.nestedPort('smtp.port', smtp.port);
    this.nestedPositiveInt('smtp.maxConnections', smtp.maxConnections);
    this.nestedPositiveInt('smtp.maxMessages', smtp.maxMessages);
    if (smtp.from !== undefined && smtp.from.length === 0) {
      this.fail('smtp.from', 'must be a non-empty string', smtp.from);
    }
  }

  /** Port check for a nested leaf — the typed `port` helper is top-level only. */
  private nestedPort(field: string, value: number | undefined): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
      this.fail(field, 'must be an integer port in [1, 65535]', value);
    }
  }

  /** Integer `>= 1` for a nested leaf. */
  private nestedPositiveInt(field: string, value: number | undefined): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.fail(field, 'must be an integer >= 1', value);
    }
  }
}

/**
 * Accepted input for any email-bridge-configurable constructor: the fluent
 * {@link EmailBridgeOptionsBuilder} OR a plain {@link EmailBridgeOptionsType}
 * object.
 */
export type EmailBridgeOptions = EmailBridgeOptionsBuilder | Partial<EmailBridgeOptionsType>;
/** Value alias so `EmailBridgeOptions.create()` / `new EmailBridgeOptions()` resolve to the builder. */
export const EmailBridgeOptions = EmailBridgeOptionsBuilder;
