import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import {
  DEFAULT_EMAIL_ACKNOWLEDGMENT_TIMEOUT_MS,
  DEFAULT_EMAIL_MAX_MESSAGE_BYTES,
  DEFAULT_IMAP_MAILBOX,
  DEFAULT_IMAP_MAX_IDLE_TIME_MS,
  DEFAULT_IMAP_POLL_INTERVAL_MS,
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_MAX_CONNECTIONS,
  DEFAULT_SMTP_MAX_MESSAGES,
  DEFAULT_SMTP_PORT,
  EmailBridgeOptionsValidator,
} from './EmailBridgeOptions.js';
import type {
  EmailBridgeOptions,
  EmailBridgeOptionsType,
  EmailImapOptionsType,
  EmailSmtpOptionsType,
} from './EmailBridgeOptions.js';

/** One parsed address from an inbound message's envelope. */
export type EmailAddress = {
  readonly name?: string;
  readonly address: string;
};

/**
 * An inbound message, delivered to the configured target actor.
 *
 * Carries the envelope and the decoded text bodies — not attachments: a
 * mailbox is untrusted input and a bridge that eagerly downloaded every
 * attachment would be a memory amplifier.  `size` reports the full RFC822
 * size, so a consumer that wants the rest can fetch it out of band.
 */
export type EmailMessage = {
  readonly mailbox: string;
  /** IMAP UID within {@link mailbox} — informational; settling goes by {@link ackToken}. */
  readonly uid: number;
  readonly from?: EmailAddress;
  readonly to: ReadonlyArray<EmailAddress>;
  readonly cc?: ReadonlyArray<EmailAddress>;
  readonly subject?: string;
  readonly date?: Date;
  readonly messageId?: string;
  /** Decoded `text/plain` body, cut at `imap.maxMessageBytes`. */
  readonly text?: string;
  /** Decoded `text/html` body, cut at `imap.maxMessageBytes`. */
  readonly html?: string;
  /** Whether a body part hit the byte cap and was cut. */
  readonly truncated: boolean;
  /** Full message size in bytes, as reported by the server. */
  readonly size?: number;
  /**
   * Acknowledgment token.  Tell `{ kind: 'acknowledgment', ackToken }` back
   * to the bridge once the message is processed — only then is it flagged
   * (or moved) and dropped from the sweep.  Anything else — a negative
   * acknowledgment, a timeout, a crash — leaves it for redelivery.
   */
  readonly ackToken: number;
};

/** An attachment on an outgoing message. */
export type EmailAttachment = {
  readonly filename: string;
  readonly content: Uint8Array | string;
  readonly contentType?: string;
};

/** An outgoing message.  `from` falls back to `smtp.from`. */
export type EmailSend = {
  readonly to: string | ReadonlyArray<string>;
  readonly cc?: string | ReadonlyArray<string>;
  readonly bcc?: string | ReadonlyArray<string>;
  readonly from?: string;
  readonly replyTo?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: ReadonlyArray<EmailAttachment>;
};

/*
 * The variants carry the `Email` prefix rather than the bare
 * `PascalCase(kind) + Command` form: `send` and `acknowledgment` are kinds
 * several brokers have, and these names are re-exported from one flat
 * barrel — `TcpServerActor` already owns `SendCommand` there.
 */
export type EmailSendCommand = { readonly kind: 'send'; readonly email: EmailSend };
/** Settles an inbound message: flag it seen (or move it) so it is not redelivered. */
export type EmailAcknowledgmentCommand = { readonly kind: 'acknowledgment'; readonly ackToken: number };
/**
 * Refuses an inbound message.  By default it is simply left unflagged, so
 * the next sweep delivers it again.  `drop: true` settles it *without*
 * having processed it — the escape hatch for a message that fails every
 * time and would otherwise be redelivered forever.
 */
export type EmailNegativeAcknowledgmentCommand = {
  readonly kind: 'negativeAcknowledgment';
  readonly ackToken: number;
  readonly drop?: boolean;
};

export type EmailBridgeCommand =
  | EmailSendCommand
  | EmailAcknowledgmentCommand
  | EmailNegativeAcknowledgmentCommand;

/** What the bridge remembers about a delivered-but-unsettled message. */
type PendingAcknowledgment = {
  readonly uid: number;
  /**
   * The mailbox's UIDVALIDITY when the message was fetched.  A server may
   * renumber UIDs across sessions; settling a stale UID would flag whatever
   * message now holds that number.
   */
  readonly uidValidity: string;
  readonly timer: ReturnType<typeof setTimeout>;
};

/**
 * Bridges a mailbox into the actor system: IMAP IDLE in, pooled SMTP out.
 * The ops/alerting integration that otherwise gets hand-rolled per project.
 *
 * **Inbound is at-least-once, settled by IMAP flags.**  The bridge sweeps
 * the mailbox for unprocessed mail, delivers each message to
 * `options.target`, and waits.  Only an `acknowledgment` marks the message
 * `\Seen` (or moves it away); until then it stays in the swept set, so a
 * crash, a lost connection, or an actor that never answers all end in the
 * same place — the message is delivered again:
 *
 * ```ts
 * class AlertHandler extends Actor<EmailMessage> {
 *   constructor(private readonly bridge: ActorRef<EmailBridgeCommand>) { super(); }
 *   async onReceive(message: EmailMessage): Promise<void> {
 *     try {
 *       await raiseIncident(message.subject ?? '(no subject)');
 *       this.bridge.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
 *     } catch {
 *       this.bridge.tell({ kind: 'negativeAcknowledgment', ackToken: message.ackToken });
 *     }
 *   }
 * }
 * ```
 *
 * **One actor watches one mailbox.**  An IMAP connection can IDLE only on
 * the mailbox it has selected, so a second mailbox means a second actor.
 *
 * **Reconnection is the base class's.**  `imapflow` does not reconnect on
 * its own; its `close` event is wired straight to `handleConnectionLost`,
 * which is what gives the bridge backoff, jitter and the circuit breaker
 * without a knob of its own.
 *
 * Both drivers are optional peer dependencies, imported on first connect:
 * `npm install imapflow nodemailer` (only the half you configure is loaded).
 */
export class EmailBridgeActor extends BrokerActor<EmailBridgeOptionsType, EmailBridgeCommand, EmailSend> {
  private imapClient: ImapFlowClientLike | null = null;
  private smtpTransporter: SmtpTransporterLike | null = null;
  /** Guards the inbound loop against an intentional teardown (see SseActor). */
  private inboundLoopRunning = false;
  private readonly pendingAcknowledgments = new Map<number, PendingAcknowledgment>();
  /** UIDs delivered but not yet settled — keeps a sweep from delivering them twice. */
  private readonly inFlightUids = new Set<number>();
  private nextAcknowledgmentToken = 1;
  /** Resolves the current idle/poll wait early when the server announces new mail. */
  private wakeInboundLoop: (() => void) | null = null;
  /** Timer behind the current wait, so an abandoned one can be cancelled. */
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EmailBridgeOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.emailBridge; }

  /**
   * Empty on purpose — every default belongs to a nested group, and
   * `mergeOptions` replaces a group wholesale rather than merging into it.
   * The defaults are applied where the fields are read; see the module
   * comment on `EmailBridgeOptions`.
   */
  protected builtInDefaultOptions(): Partial<EmailBridgeOptionsType> { return {}; }

  protected readOptionsFromConfig(config: Config): Partial<EmailBridgeOptionsType> {
    const out: { -readonly [K in keyof EmailBridgeOptionsType]?: EmailBridgeOptionsType[K] } = {};
    if (config.hasPath('imap')) out.imap = readImapOptions(config.getConfig('imap'));
    if (config.hasPath('smtp')) out.smtp = readSmtpOptions(config.getConfig('smtp'));
    return out;
  }

  /** Empty — which side is required depends on the other, so the validator decides. */
  protected requiredOptions(): ReadonlyArray<keyof EmailBridgeOptionsType> { return []; }

  protected override optionsValidator(): EmailBridgeOptionsValidator {
    return new EmailBridgeOptionsValidator();
  }

  protected endpointLabel(): string {
    const { imap, smtp } = this.options;
    const parts: string[] = [];
    if (imap !== undefined) parts.push(`imap://${imap.host}:${imap.port ?? DEFAULT_IMAP_PORT}`);
    if (smtp !== undefined) parts.push(`smtp://${smtp.host}:${smtp.port ?? DEFAULT_SMTP_PORT}`);
    return parts.length > 0 ? parts.join(' + ') : '<unconfigured>';
  }

  protected async connectImplementation(): Promise<void> {
    const { imap, smtp } = this.options;
    if (smtp !== undefined) await this.connectSmtp(smtp);
    if (imap !== undefined) await this.connectImap(imap);
  }

  protected async disconnectImplementation(): Promise<void> {
    // Order matters: stop the loop and unhook the events before closing, or
    // the driver's own `close` event reads as an outage and books a
    // reconnect for a connection we are deliberately taking down.
    this.inboundLoopRunning = false;
    this.wakeInboundLoop?.();
    this.wakeInboundLoop = null;
    // Every timer goes too: one left pending holds the event loop open, so a
    // stopped bridge would keep the process alive until it fired.
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;

    for (const pending of this.pendingAcknowledgments.values()) clearTimeout(pending.timer);
    this.pendingAcknowledgments.clear();
    this.inFlightUids.clear();

    const client = this.imapClient;
    this.imapClient = null;
    if (client !== null) {
      try { client.removeAllListeners(); } catch { /* ignore */ }
      try { await client.logout(); } catch { try { client.close(); } catch { /* ignore */ } }
    }

    const transporter = this.smtpTransporter;
    this.smtpTransporter = null;
    try { transporter?.close(); } catch { /* ignore */ }
  }

  protected async dispatchOutgoing(envelope: OutboundEnvelope<EmailSend>): Promise<void> {
    const transporter = this.smtpTransporter;
    if (transporter === null) throw new Error('EmailBridgeActor: SMTP transport not open');
    try {
      await transporter.sendMail(toNodemailerMessage(envelope.payload, this.options.smtp?.from));
    } catch (e) {
      // A message the server refused is this message's problem.  Rethrowing
      // would put it back at the head of the buffer and tear down a healthy
      // pool — the bridge would then retry the same rejected mail forever.
      if (isMessageLevelSmtpFailure(e)) {
        this.log.error(`EmailBridgeActor: message rejected by the SMTP server — dropped: ${errorMessage(e)}`);
        return;
      }
      throw e;
    }
  }

  override onReceive(command: EmailBridgeCommand): void {
    match(command)
      .with({ kind: 'send' }, (c) => this.onSend(c))
      .with({ kind: 'acknowledgment' }, (c) => this.onAcknowledgment(c))
      .with({ kind: 'negativeAcknowledgment' }, (c) => this.onNegativeAcknowledgment(c))
      .exhaustive();
  }

  /* ------------------------------ commands ------------------------------ */

  private onSend(command: EmailSendCommand): void {
    if (this.options.smtp === undefined) {
      // Refuse here rather than in `dispatchOutgoing`: buffering toward a
      // side that was never configured only delays the same error until
      // after a pointless reconnect cycle.
      this.log.error('EmailBridgeActor: send refused — no `smtp` options configured');
      return;
    }
    this.enqueueOutbound(command.email);
  }

  private onAcknowledgment(command: EmailAcknowledgmentCommand): void {
    const pending = this.takePending(command.ackToken);
    if (pending === undefined) return;
    void this.settle(pending);
  }

  private onNegativeAcknowledgment(command: EmailNegativeAcknowledgmentCommand): void {
    const pending = this.takePending(command.ackToken);
    if (pending === undefined) return;
    if (command.drop === true) {
      void this.settle(pending);
      return;
    }
    // Left unflagged on purpose — the next sweep finds it again.
    this.log.debug(`EmailBridgeActor: uid=${pending.uid} refused — left for redelivery`);
  }

  /* ------------------------------- SMTP --------------------------------- */

  private async connectSmtp(smtp: EmailSmtpOptionsType): Promise<void> {
    const nodemailer = await this.nodemailerModule();
    this.smtpTransporter = nodemailer.createTransport({
      host: smtp.host!,
      port: smtp.port ?? DEFAULT_SMTP_PORT,
      secure: smtp.secure ?? false,
      auth: smtp.user !== undefined ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
      pool: true,
      maxConnections: smtp.maxConnections ?? DEFAULT_SMTP_MAX_CONNECTIONS,
      maxMessages: smtp.maxMessages ?? DEFAULT_SMTP_MAX_MESSAGES,
    });
    // Probe now so a wrong host or a rejected login fails the connect —
    // which the base class answers with backoff — instead of surfacing on
    // whichever message happens to be sent first.
    await this.smtpTransporter.verify();
  }

  /* ------------------------------- IMAP --------------------------------- */

  private async connectImap(imap: EmailImapOptionsType): Promise<void> {
    const module = await this.imapflowModule();
    const client = new module.ImapFlow({
      host: imap.host!,
      port: imap.port ?? DEFAULT_IMAP_PORT,
      secure: imap.secure ?? true,
      auth: imap.user !== undefined ? { user: imap.user, pass: imap.password ?? '' } : undefined,
      // The bridge drives IDLE itself so it can interleave sweeps with it.
      disableAutoIdle: true,
      maxIdleTime: imap.maxIdleTimeMs ?? DEFAULT_IMAP_MAX_IDLE_TIME_MS,
      logger: false,
    });

    await client.connect();
    if ((imap.onProcessed ?? 'markSeen') === 'move') {
      // A move into a mailbox that does not exist fails, and a settle that
      // fails leaves the message unflagged — so it is delivered again, and
      // again, forever.  Creating it once here is the difference between a
      // working bridge and a livelock nothing reports.
      try {
        await client.mailboxCreate(imap.moveToMailbox!);
      } catch {
        // Already there — the only other outcome worth having.
      }
    }
    await client.mailboxOpen(imap.mailbox ?? DEFAULT_IMAP_MAILBOX);
    this.imapClient = client;

    const onDown = (cause: Error): void => {
      if (!this.inboundLoopRunning) return;
      this.inboundLoopRunning = false;
      this.wakeInboundLoop?.();
      this.handleConnectionLost(cause);
    };
    client.on('error', (e: Error) => onDown(e));
    client.on('close', () => onDown(new Error('imap connection closed')));
    client.on('exists', () => this.wakeInboundLoop?.());

    this.inboundLoopRunning = true;
    void this.runInboundLoop(client, imap);
  }

  /**
   * Sweep, wait, repeat — for the life of the connection.  Every error ends
   * the connection rather than the loop: a half-working IMAP session that
   * keeps looping would silently stop delivering mail, whereas a lost
   * connection is something the base class knows how to rebuild.
   */
  private async runInboundLoop(client: ImapFlowClientLike, imap: EmailImapOptionsType): Promise<void> {
    const pollIntervalMs = imap.pollIntervalMs ?? DEFAULT_IMAP_POLL_INTERVAL_MS;
    const useIdle = imap.disableIdle !== true && supportsIdle(client);
    try {
      while (this.inboundLoopRunning) {
        await this.sweepMailbox(client, imap);
        if (!this.inboundLoopRunning) break;
        if (useIdle) {
          // Whichever comes first: the server announcing mail, the IDLE
          // stretch ending, or the poll interval elapsing.  The interval is
          // the backstop that bounds how long a refused message waits to be
          // redelivered when nothing new arrives.
          await Promise.race([client.idle(), this.waitForWake(pollIntervalMs)]);
        } else {
          await this.waitForWake(pollIntervalMs);
          if (this.inboundLoopRunning) await client.noop();
        }
      }
    } catch (e) {
      if (this.inboundLoopRunning) {
        this.inboundLoopRunning = false;
        this.handleConnectionLost(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** Deliver every message the mailbox holds that has not been processed yet. */
  private async sweepMailbox(client: ImapFlowClientLike, imap: EmailImapOptionsType): Promise<void> {
    // In `markSeen` mode the `\Seen` flag is the processed marker; in `move`
    // mode a processed message is simply not in this mailbox any more.
    const query = (imap.onProcessed ?? 'markSeen') === 'move' ? { all: true } : { seen: false };
    // `false` is how the driver reports a search it could not run at all.
    const found = await client.search(query, { uid: true });
    const uids = found === false ? [] : found;
    for (const uid of uids) {
      if (!this.inboundLoopRunning) return;
      if (this.inFlightUids.has(uid)) continue;
      try {
        await this.deliver(client, imap, uid);
      } catch (e) {
        // One unreadable message must not stall the mailbox behind it.  It
        // stays unflagged, so the next sweep tries it again.
        this.log.warn(`EmailBridgeActor: could not fetch uid=${uid}: ${errorMessage(e)}`);
      }
    }
  }

  private async deliver(client: ImapFlowClientLike, imap: EmailImapOptionsType, uid: number): Promise<void> {
    const fetched = await client.fetchOne(String(uid), { envelope: true, size: true, bodyStructure: true }, { uid: true });
    if (!fetched) return;

    const maxBytes = imap.maxMessageBytes ?? DEFAULT_EMAIL_MAX_MESSAGE_BYTES;
    const parts = pickTextParts(fetched.bodyStructure);
    let text: string | undefined;
    let html: string | undefined;
    let truncated = false;
    for (const part of parts) {
      const body = await this.downloadPart(client, uid, part.part, maxBytes);
      if (body === undefined) continue;
      if (body.truncated) truncated = true;
      if (part.kind === 'text') text = body.content;
      else html = body.content;
    }

    const envelope = fetched.envelope;
    const ackToken = this.nextAcknowledgmentToken++;
    const message: EmailMessage = {
      mailbox: imap.mailbox ?? DEFAULT_IMAP_MAILBOX,
      uid,
      from: firstAddress(envelope?.from),
      to: toAddressList(envelope?.to),
      cc: envelope?.cc !== undefined ? toAddressList(envelope.cc) : undefined,
      subject: envelope?.subject,
      date: envelope?.date,
      messageId: envelope?.messageId,
      text,
      html,
      truncated,
      size: fetched.size,
      ackToken,
    };

    const timer = setTimeout(() => {
      this.pendingAcknowledgments.delete(ackToken);
      this.inFlightUids.delete(uid);
      this.log.warn(
        `EmailBridgeActor: no acknowledgment for uid=${uid} within `
        + `${imap.acknowledgmentTimeoutMs ?? DEFAULT_EMAIL_ACKNOWLEDGMENT_TIMEOUT_MS}ms `
        + '— leaving it unflagged for redelivery',
      );
    }, imap.acknowledgmentTimeoutMs ?? DEFAULT_EMAIL_ACKNOWLEDGMENT_TIMEOUT_MS);

    this.pendingAcknowledgments.set(ackToken, { uid, uidValidity: currentUidValidity(client), timer });
    this.inFlightUids.add(uid);
    this.options.target?.tell(message);
  }

  private async downloadPart(
    client: ImapFlowClientLike,
    uid: number,
    part: string,
    maxBytes: number,
  ): Promise<{ content: string; truncated: boolean } | undefined> {
    const downloaded = await client.download(String(uid), part, { uid: true });
    if (downloaded === false || downloaded.content === undefined) return undefined;
    return readCapped(downloaded.content, maxBytes);
  }

  /** Remove a pending entry and stop its timeout.  Unknown tokens are a no-op. */
  private takePending(ackToken: number): PendingAcknowledgment | undefined {
    const pending = this.pendingAcknowledgments.get(ackToken);
    if (pending === undefined) {
      // Already settled, timed out, or delivered before a reconnect — all of
      // them end in a redelivery rather than a lost message, so none is an error.
      this.log.debug(`EmailBridgeActor: acknowledgment for unknown ackToken=${ackToken} — ignored`);
      return undefined;
    }
    clearTimeout(pending.timer);
    this.pendingAcknowledgments.delete(ackToken);
    this.inFlightUids.delete(pending.uid);
    return pending;
  }

  /**
   * Flag or move a settled message — deliberately not awaited.  Awaiting it
   * would park the mailbox behind an IMAP round-trip for every message, and
   * a settle that fails costs one redelivery, not correctness.
   */
  private async settle(pending: PendingAcknowledgment): Promise<void> {
    const client = this.imapClient;
    const imap = this.options.imap;
    if (client === null || imap === undefined) return;
    // UIDs are only meaningful within one UIDVALIDITY.  If the server
    // renumbered the mailbox, this UID now points at someone else's mail.
    if (currentUidValidity(client) !== pending.uidValidity) {
      this.log.debug(`EmailBridgeActor: uid=${pending.uid} settle skipped — mailbox was renumbered`);
      return;
    }
    try {
      if ((imap.onProcessed ?? 'markSeen') === 'move') {
        await client.messageMove(String(pending.uid), imap.moveToMailbox!, { uid: true });
      } else {
        await client.messageFlagsAdd(String(pending.uid), ['\\Seen'], { uid: true });
      }
    } catch (e) {
      this.log.warn(`EmailBridgeActor: could not settle uid=${pending.uid}: ${errorMessage(e)}`);
    }
  }

  /**
   * Sleep, but wake early when the server announces new mail.  One waiter at
   * a time — the loop is the only caller.
   *
   * The previous waiter's timer is cancelled first.  When `idle()` wins the
   * race the waiter it was raced against is abandoned unsettled, and a timer
   * left running from an abandoned waiter would later fire and clear the
   * *current* wake handle — after which an `exists` notification would find
   * nothing to wake and the loop would sleep out the full interval.
   */
  private waitForWake(timeoutMs: number): Promise<void> {
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeInboundLoop === finish) this.wakeInboundLoop = null;
        if (this.wakeTimer === timer) this.wakeTimer = null;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wakeTimer = timer;
      this.wakeInboundLoop = finish;
    });
  }

  /* ------------------------------ test seams ---------------------------- */

  /** @internal Overridden in tests to inject a fake driver. */
  protected imapflowModule(): Promise<ImapFlowModuleLike> { return imapflowLazy.get(); }
  /** @internal Overridden in tests to inject a fake driver. */
  protected nodemailerModule(): Promise<NodemailerModuleLike> { return nodemailerLazy.get(); }
}

/* ------------------------------- helpers -------------------------------- */

/**
 * Whether an SMTP failure is about the message rather than the connection.
 * Message-level failures are dropped; everything else is rethrown so the
 * base class rebuilds the connection and retries the message.
 *
 * Exported because the taxonomy is the interesting half of the outbound
 * path and deserves testing without a live server.
 */
export function isMessageLevelSmtpFailure(error: unknown): boolean {
  const candidate = error as { code?: unknown; responseCode?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : undefined;
  // Connection, TLS, DNS and authentication failures say nothing about the
  // message — the same message may well go through on a fresh connection.
  if (code !== undefined && TRANSPORT_ERROR_CODES.has(code)) return false;
  const responseCode = typeof candidate?.responseCode === 'number' ? candidate.responseCode : undefined;
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 600) return true;
  return code === 'EENVELOPE' || code === 'EMESSAGE';
}

const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'ECONNRESET', 'EDNS', 'EAUTH', 'EPIPE',
]);

/** A text body part worth downloading, and which field it fills. */
export type EmailTextPart = { readonly part: string; readonly kind: 'text' | 'html' };

/**
 * Walk a BODYSTRUCTURE and pick the `text/plain` and `text/html` parts —
 * the first of each, which is what a `multipart/alternative` message wants.
 * Exported for testing: the shape is recursive and the single-part case is
 * the one that is easy to get wrong.
 */
export function pickTextParts(node: ImapBodyStructureLike | undefined): ReadonlyArray<EmailTextPart> {
  if (node === undefined) return [];
  const found: EmailTextPart[] = [];
  const visit = (current: ImapBodyStructureLike): void => {
    const type = (current.type ?? '').toLowerCase();
    if (current.childNodes !== undefined && current.childNodes.length > 0) {
      for (const child of current.childNodes) visit(child);
      return;
    }
    const kind = type === 'text/plain' ? 'text' : type === 'text/html' ? 'html' : undefined;
    if (kind === undefined) return;
    if (found.some((f) => f.kind === kind)) return;
    // A single-part message has no part number of its own; `1` is what the
    // IMAP grammar calls its one and only body part.
    found.push({ part: current.part ?? '1', kind });
  };
  visit(node);
  return found;
}

/**
 * Read a body stream, stopping at `maxBytes`.  A mailbox is untrusted
 * input, so the cap is what keeps one oversized message from being the
 * whole heap; the caller reports the cut as `truncated`.
 */
async function readCapped(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  const decoder = new TextDecoder('utf-8');
  let content = '';
  let read = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const remaining = maxBytes - read;
    if (chunk.length >= remaining) {
      content += decoder.decode(chunk.subarray(0, remaining), { stream: false });
      truncated = true;
      break;
    }
    content += decoder.decode(chunk, { stream: true });
    read += chunk.length;
  }
  return { content, truncated };
}

/** Map the public outbound shape onto nodemailer's message object. */
function toNodemailerMessage(email: EmailSend, defaultFrom: string | undefined): NodemailerMessage {
  return {
    from: email.from ?? defaultFrom,
    to: email.to as string | string[],
    cc: email.cc as string | string[] | undefined,
    bcc: email.bcc as string | string[] | undefined,
    replyTo: email.replyTo,
    subject: email.subject,
    text: email.text,
    html: email.html,
    headers: email.headers,
    attachments: email.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };
}

function firstAddress(addresses: ReadonlyArray<ImapEnvelopeAddressLike> | undefined): EmailAddress | undefined {
  const list = toAddressList(addresses);
  return list.length > 0 ? list[0] : undefined;
}

function toAddressList(addresses: ReadonlyArray<ImapEnvelopeAddressLike> | undefined): ReadonlyArray<EmailAddress> {
  if (addresses === undefined) return [];
  const out: EmailAddress[] = [];
  for (const entry of addresses) {
    if (entry.address === undefined) continue;
    out.push(entry.name !== undefined && entry.name.length > 0
      ? { name: entry.name, address: entry.address }
      : { address: entry.address });
  }
  return out;
}

/** UIDVALIDITY as a string — servers report a 32-bit value, drivers as BigInt or number. */
function currentUidValidity(client: ImapFlowClientLike): string {
  const value = client.mailbox?.uidValidity;
  return value === undefined ? '' : String(value);
}

function supportsIdle(client: ImapFlowClientLike): boolean {
  const capabilities = client.capabilities;
  // No capability map at all: assume IDLE and let the fallback happen on the
  // first failure rather than polling a server that supports it.
  if (capabilities === undefined) return true;
  return capabilities.has('IDLE');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* --------------------------- HOCON leaf readers -------------------------- */

function readImapOptions(config: Config): EmailImapOptionsType {
  const out: { -readonly [K in keyof EmailImapOptionsType]?: EmailImapOptionsType[K] } = {};
  if (config.hasPath('host')) out.host = config.getString('host');
  if (config.hasPath('port')) out.port = config.getInt('port');
  if (config.hasPath('secure')) out.secure = config.getBoolean('secure');
  if (config.hasPath('user')) out.user = config.getString('user');
  if (config.hasPath('password')) out.password = config.getString('password');
  if (config.hasPath('mailbox')) out.mailbox = config.getString('mailbox');
  if (config.hasPath('onProcessed')) out.onProcessed = config.getString('onProcessed') as EmailImapOptionsType['onProcessed'];
  if (config.hasPath('moveToMailbox')) out.moveToMailbox = config.getString('moveToMailbox');
  if (config.hasPath('disableIdle')) out.disableIdle = config.getBoolean('disableIdle');
  if (config.hasPath('maxIdleTimeMs')) out.maxIdleTimeMs = config.getDuration('maxIdleTimeMs');
  if (config.hasPath('pollIntervalMs')) out.pollIntervalMs = config.getDuration('pollIntervalMs');
  if (config.hasPath('maxMessageBytes')) out.maxMessageBytes = config.getInt('maxMessageBytes');
  if (config.hasPath('acknowledgmentTimeoutMs')) out.acknowledgmentTimeoutMs = config.getDuration('acknowledgmentTimeoutMs');
  return out;
}

function readSmtpOptions(config: Config): EmailSmtpOptionsType {
  const out: { -readonly [K in keyof EmailSmtpOptionsType]?: EmailSmtpOptionsType[K] } = {};
  if (config.hasPath('host')) out.host = config.getString('host');
  if (config.hasPath('port')) out.port = config.getInt('port');
  if (config.hasPath('secure')) out.secure = config.getBoolean('secure');
  if (config.hasPath('user')) out.user = config.getString('user');
  if (config.hasPath('password')) out.password = config.getString('password');
  if (config.hasPath('from')) out.from = config.getString('from');
  if (config.hasPath('maxConnections')) out.maxConnections = config.getInt('maxConnections');
  if (config.hasPath('maxMessages')) out.maxMessages = config.getInt('maxMessages');
  return out;
}

/* ---------------------------- driver seams ------------------------------ */
/* Minimal structural shapes, exported so a test can satisfy them without   */
/* the peer dependencies installed.                                         */

export type ImapEnvelopeAddressLike = { readonly name?: string; readonly address?: string };

export type ImapEnvelopeLike = {
  readonly date?: Date;
  readonly subject?: string;
  readonly messageId?: string;
  readonly from?: ReadonlyArray<ImapEnvelopeAddressLike>;
  readonly to?: ReadonlyArray<ImapEnvelopeAddressLike>;
  readonly cc?: ReadonlyArray<ImapEnvelopeAddressLike>;
};

export type ImapBodyStructureLike = {
  readonly part?: string;
  readonly type?: string;
  readonly childNodes?: ReadonlyArray<ImapBodyStructureLike>;
};

export type ImapFetchedMessageLike = {
  readonly uid?: number;
  readonly size?: number;
  readonly envelope?: ImapEnvelopeLike;
  readonly bodyStructure?: ImapBodyStructureLike;
};

export type ImapSearchQueryLike = { readonly seen?: boolean; readonly all?: boolean };

export interface ImapFlowClientLike {
  connect(): Promise<void>;
  mailboxOpen(mailbox: string): Promise<unknown>;
  /** Rejects when the mailbox already exists, which the caller treats as success. */
  mailboxCreate(path: string): Promise<unknown>;
  readonly mailbox?: { readonly uidValidity?: unknown };
  readonly capabilities?: { has(capability: string): boolean };
  search(query: ImapSearchQueryLike, options: { uid: true }): Promise<ReadonlyArray<number> | false>;
  fetchOne(
    range: string,
    query: { envelope: true; size: true; bodyStructure: true },
    options: { uid: true },
  ): Promise<ImapFetchedMessageLike | false>;
  download(
    range: string,
    part: string,
    options: { uid: true },
  ): Promise<{ content?: AsyncIterable<Uint8Array> } | false>;
  messageFlagsAdd(range: string, flags: ReadonlyArray<string>, options: { uid: true }): Promise<unknown>;
  messageMove(range: string, destination: string, options: { uid: true }): Promise<unknown>;
  idle(): Promise<unknown>;
  noop(): Promise<unknown>;
  logout(): Promise<unknown>;
  close(): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close' | 'exists', listener: () => void): void;
  removeAllListeners(): void;
}

export type ImapFlowOptionsLike = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly disableAutoIdle?: boolean;
  readonly maxIdleTime?: number;
  readonly logger?: false;
};

export interface ImapFlowModuleLike {
  readonly ImapFlow: new (options: ImapFlowOptionsLike) => ImapFlowClientLike;
}

export type NodemailerAttachment = {
  readonly filename: string;
  readonly content: Uint8Array | string;
  readonly contentType?: string;
};

export type NodemailerMessage = {
  readonly from?: string;
  readonly to: string | string[];
  readonly cc?: string | string[];
  readonly bcc?: string | string[];
  readonly replyTo?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: ReadonlyArray<NodemailerAttachment>;
};

export type NodemailerTransportOptionsLike = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly pool: true;
  readonly maxConnections: number;
  readonly maxMessages: number;
};

export interface SmtpTransporterLike {
  sendMail(message: NodemailerMessage): Promise<unknown>;
  verify(): Promise<unknown>;
  close(): void;
}

export interface NodemailerModuleLike {
  createTransport(options: NodemailerTransportOptionsLike): SmtpTransporterLike;
}

const imapflowLazy: Lazy<Promise<ImapFlowModuleLike>> = Lazy.of(
  () => lazyImportModule<ImapFlowModuleLike>('imapflow', { context: 'EmailBridgeActor' }),
);

const nodemailerLazy: Lazy<Promise<NodemailerModuleLike>> = Lazy.of(async () => {
  // nodemailer ships CJS with `module.exports = …`; under ESM that arrives as
  // the default export in some runtimes and as the namespace in others.
  const imported = await lazyImportModule<NodemailerModuleLike & { default?: NodemailerModuleLike }>(
    'nodemailer', { context: 'EmailBridgeActor' },
  );
  return typeof imported.createTransport === 'function' ? imported : imported.default!;
});
