import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Actor } from '../../../../../src/Actor.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';
import {
  EmailBridgeActor,
  isMessageLevelSmtpFailure,
  pickTextParts,
  type EmailBridgeCommand,
  type EmailMessage,
  type ImapBodyStructureLike,
  type ImapEnvelopeLike,
  type ImapFetchedMessageLike,
  type ImapFlowClientLike,
  type ImapFlowModuleLike,
  type ImapFlowOptionsLike,
  type ImapSearchQueryLike,
  type NodemailerMessage,
  type NodemailerModuleLike,
  type NodemailerTransportOptionsLike,
  type SmtpTransporterLike,
} from '../../../../../src/io/broker/EmailBridgeActor.js';
import {
  EmailBridgeOptions,
  type EmailBridgeOptionsType,
} from '../../../../../src/io/broker/EmailBridgeOptions.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- pure helpers ---------------------------- */

describe('pickTextParts', () => {
  test('single-part text message uses part 1', () => {
    expect(pickTextParts({ type: 'text/plain' })).toEqual([{ part: '1', kind: 'text' }]);
  });

  test('multipart/alternative picks both bodies', () => {
    const structure: ImapBodyStructureLike = {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'text/html' },
      ],
    };
    expect(pickTextParts(structure)).toEqual([
      { part: '1', kind: 'text' },
      { part: '2', kind: 'html' },
    ]);
  });

  test('only the first part of each kind is taken', () => {
    const structure: ImapBodyStructureLike = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'text/plain' },
      ],
    };
    expect(pickTextParts(structure)).toEqual([{ part: '1', kind: 'text' }]);
  });

  test('attachments and unknown types are skipped', () => {
    const structure: ImapBodyStructureLike = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'application/pdf' },
        { part: '3', type: 'image/png' },
      ],
    };
    expect(pickTextParts(structure)).toEqual([{ part: '1', kind: 'text' }]);
  });

  test('nested multipart is walked', () => {
    const structure: ImapBodyStructureLike = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'TEXT/HTML' }] },
        { part: '2', type: 'application/pdf' },
      ],
    };
    expect(pickTextParts(structure)).toEqual([{ part: '1.1', kind: 'html' }]);
  });

  test('undefined structure yields nothing', () => {
    expect(pickTextParts(undefined)).toEqual([]);
  });
});

describe('isMessageLevelSmtpFailure', () => {
  test('a 5xx rejection is about the message', () => {
    expect(isMessageLevelSmtpFailure({ responseCode: 550, message: 'no such user' })).toBe(true);
  });

  test('a 4xx rejection is about the message too', () => {
    expect(isMessageLevelSmtpFailure({ responseCode: 452, message: 'mailbox full' })).toBe(true);
  });

  test('envelope and message errors are about the message', () => {
    expect(isMessageLevelSmtpFailure({ code: 'EENVELOPE' })).toBe(true);
    expect(isMessageLevelSmtpFailure({ code: 'EMESSAGE' })).toBe(true);
  });

  test('connection-level failures are not', () => {
    for (const code of ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'ECONNRESET', 'EDNS', 'EAUTH', 'EPIPE']) {
      expect(isMessageLevelSmtpFailure({ code })).toBe(false);
    }
  });

  test('a transport code wins over a response code', () => {
    // nodemailer attaches a responseCode to some connection failures; the
    // connection is still the thing that broke.
    expect(isMessageLevelSmtpFailure({ code: 'ECONNECTION', responseCode: 421 })).toBe(false);
  });

  test('an unclassifiable error is treated as connection-level', () => {
    expect(isMessageLevelSmtpFailure(new Error('boom'))).toBe(false);
    expect(isMessageLevelSmtpFailure(undefined)).toBe(false);
  });
});

/* ------------------------------ fake IMAP ------------------------------ */

type FakeMail = {
  readonly uid: number;
  seen: boolean;
  readonly envelope: ImapEnvelopeLike;
  readonly size: number;
  readonly bodyStructure: ImapBodyStructureLike;
  /** Part id → decoded body. */
  readonly parts: Readonly<Record<string, string>>;
};

function textMail(uid: number, subject: string, body: string, seen = false): FakeMail {
  return {
    uid,
    seen,
    envelope: {
      subject,
      messageId: `<${uid}@example.test>`,
      date: new Date('2026-08-18T10:00:00Z'),
      from: [{ name: 'Ops Bot', address: 'ops@example.test' }],
      to: [{ address: 'bridge@example.test' }],
    },
    size: body.length,
    bodyStructure: { type: 'text/plain' },
    parts: { '1': body },
  };
}

async function* bytesOf(value: string): AsyncGenerator<Uint8Array> {
  // Two chunks, so the byte cap is exercised across a chunk boundary.
  const encoded = new TextEncoder().encode(value);
  const half = Math.ceil(encoded.length / 2);
  yield encoded.subarray(0, half);
  if (half < encoded.length) yield encoded.subarray(half);
}

class FakeImapClient implements ImapFlowClientLike {
  readonly flagAdds: Array<{ uid: string; flags: ReadonlyArray<string> }> = [];
  readonly moves: Array<{ uid: string; destination: string }> = [];
  readonly searches: ImapSearchQueryLike[] = [];
  readonly mailboxCreates: string[] = [];
  /** Mailboxes that already exist — creating one of these rejects, as a server would. */
  readonly existingMailboxes = new Set<string>();
  idleCalls = 0;
  noopCalls = 0;
  logoutCalls = 0;
  closeCalls = 0;
  uidValidity: unknown = 42n;
  capabilities: { has(capability: string): boolean } | undefined = new Set(['IDLE']);
  /** Set to reject the next fetchOne — models an unreadable message. */
  failFetchForUid: number | null = null;

  private mails: FakeMail[];
  private errorListeners: Array<(error: Error) => void> = [];
  private closeListeners: Array<() => void> = [];
  private existsListeners: Array<() => void> = [];
  private pendingIdle: (() => void) | null = null;

  constructor(mails: FakeMail[], readonly options: ImapFlowOptionsLike) {
    this.mails = mails;
  }

  get mailbox(): { uidValidity?: unknown } { return { uidValidity: this.uidValidity }; }

  async connect(): Promise<void> { /* nothing to do */ }
  async mailboxOpen(_mailbox: string): Promise<unknown> { return {}; }

  async mailboxCreate(path: string): Promise<unknown> {
    this.mailboxCreates.push(path);
    if (this.existingMailboxes.has(path)) throw new Error(`ALREADYEXISTS: ${path}`);
    this.existingMailboxes.add(path);
    return {};
  }

  async search(query: ImapSearchQueryLike, _options: { uid: true }): Promise<ReadonlyArray<number>> {
    this.searches.push(query);
    // A real client breaks IDLE to run a command; model that so the loop's
    // pending idle promise does not pile up.
    this.releaseIdle();
    const matching = query.all === true ? this.mails : this.mails.filter((m) => !m.seen);
    return matching.map((m) => m.uid);
  }

  async fetchOne(
    range: string,
    _query: { envelope: true; size: true; bodyStructure: true },
    _options: { uid: true },
  ): Promise<ImapFetchedMessageLike | false> {
    const uid = Number(range);
    if (this.failFetchForUid === uid) throw new Error(`fetch failed for uid=${uid}`);
    const mail = this.mails.find((m) => m.uid === uid);
    if (mail === undefined) return false;
    return { uid: mail.uid, size: mail.size, envelope: mail.envelope, bodyStructure: mail.bodyStructure };
  }

  async download(
    range: string,
    part: string,
    _options: { uid: true },
  ): Promise<{ content?: AsyncIterable<Uint8Array> } | false> {
    const mail = this.mails.find((m) => m.uid === Number(range));
    const body = mail?.parts[part];
    if (body === undefined) return false;
    return { content: bytesOf(body) };
  }

  async messageFlagsAdd(range: string, flags: ReadonlyArray<string>, _options: { uid: true }): Promise<unknown> {
    this.flagAdds.push({ uid: range, flags });
    const mail = this.mails.find((m) => m.uid === Number(range));
    if (mail !== undefined && flags.includes('\\Seen')) mail.seen = true;
    return true;
  }

  async messageMove(range: string, destination: string, _options: { uid: true }): Promise<unknown> {
    this.moves.push({ uid: range, destination });
    this.mails = this.mails.filter((m) => m.uid !== Number(range));
    return true;
  }

  async idle(): Promise<unknown> {
    this.idleCalls++;
    return new Promise<void>((resolve) => { this.pendingIdle = resolve; });
  }

  async noop(): Promise<unknown> { this.noopCalls++; return true; }
  async logout(): Promise<unknown> { this.logoutCalls++; this.releaseIdle(); return true; }
  close(): void { this.closeCalls++; this.releaseIdle(); }

  on(event: 'error' | 'close' | 'exists', listener: (...args: never[]) => void): void {
    if (event === 'error') this.errorListeners.push(listener as never);
    else if (event === 'close') this.closeListeners.push(listener as never);
    else this.existsListeners.push(listener as never);
  }

  removeAllListeners(): void {
    this.errorListeners = [];
    this.closeListeners = [];
    this.existsListeners = [];
  }

  /* ------------------------- test drive points ------------------------- */

  addMail(mail: FakeMail): void { this.mails.push(mail); }
  mailCount(): number { return this.mails.length; }
  fireExists(): void { for (const l of [...this.existsListeners]) l(); }
  fireClose(): void { this.releaseIdle(); for (const l of [...this.closeListeners]) l(); }
  fireError(error: Error): void { this.releaseIdle(); for (const l of [...this.errorListeners]) l(error); }

  private releaseIdle(): void {
    const resolve = this.pendingIdle;
    this.pendingIdle = null;
    resolve?.();
  }
}

class FakeImapModule implements ImapFlowModuleLike {
  readonly clients: FakeImapClient[] = [];
  /** Mail each newly constructed client starts with. */
  seed: () => FakeMail[] = () => [];
  configureClient: (client: FakeImapClient) => void = () => { /* default: leave as built */ };

  /**
   * A real `function`, not an arrow: the actor calls `new module.ImapFlow(…)`
   * and an arrow function cannot be constructed.  Returning an object from a
   * constructor call hands that object back, which is what makes this work.
   */
  readonly ImapFlow: new (options: ImapFlowOptionsLike) => ImapFlowClientLike;

  constructor() {
    const module = this;
    this.ImapFlow = function (options: ImapFlowOptionsLike): ImapFlowClientLike {
      const client = new FakeImapClient(module.seed(), options);
      module.configureClient(client);
      module.clients.push(client);
      return client;
    } as unknown as new (options: ImapFlowOptionsLike) => ImapFlowClientLike;
  }

  last(): FakeImapClient { return this.clients[this.clients.length - 1]!; }
}

/* ------------------------------ fake SMTP ------------------------------ */

class FakeTransporter implements SmtpTransporterLike {
  readonly sent: NodemailerMessage[] = [];
  closeCalls = 0;
  verifyCalls = 0;
  /** Rejection for the next verify(), consumed on use. */
  verifyFailure: Error | null = null;
  /** Rejection for every sendMail until cleared. */
  sendFailure: unknown = null;

  constructor(readonly options: NodemailerTransportOptionsLike) {}

  async sendMail(message: NodemailerMessage): Promise<unknown> {
    if (this.sendFailure !== null) throw this.sendFailure;
    this.sent.push(message);
    return { messageId: `<sent-${this.sent.length}@example.test>` };
  }

  async verify(): Promise<unknown> {
    this.verifyCalls++;
    const failure = this.verifyFailure;
    this.verifyFailure = null;
    if (failure !== null) throw failure;
    return true;
  }

  close(): void { this.closeCalls++; }
}

class FakeNodemailerModule implements NodemailerModuleLike {
  readonly transporters: FakeTransporter[] = [];
  configureTransporter: (transporter: FakeTransporter) => void = () => { /* default: leave as built */ };

  createTransport(options: NodemailerTransportOptionsLike): SmtpTransporterLike {
    const transporter = new FakeTransporter(options);
    this.configureTransporter(transporter);
    this.transporters.push(transporter);
    return transporter;
  }

  last(): FakeTransporter { return this.transporters[this.transporters.length - 1]!; }
}

/* ---------------------------- test harness ----------------------------- */

class TestEmailBridgeActor extends EmailBridgeActor {
  constructor(
    options: EmailBridgeOptions,
    readonly imapModule = new FakeImapModule(),
    readonly smtpModule = new FakeNodemailerModule(),
  ) {
    super(options);
  }

  protected override imapflowModule(): Promise<ImapFlowModuleLike> {
    return Promise.resolve(this.imapModule);
  }

  protected override nodemailerModule(): Promise<NodemailerModuleLike> {
    return Promise.resolve(this.smtpModule);
  }

  get resolvedOptions(): EmailBridgeOptionsType { return this.options; }
  get state(): string { return this.connectionState; }
  get bufferedOutbound(): number { return this.outboundBufferSize; }
}

/** Collects inbound mail; optionally acknowledges each message immediately. */
class InboxActor extends Actor<EmailMessage> {
  readonly received: EmailMessage[] = [];
  constructor(
    private readonly bridge: () => ActorRef<EmailBridgeCommand> | null,
    private readonly mode: 'acknowledge' | 'refuse' | 'drop' | 'silent' = 'acknowledge',
  ) { super(); }

  override onReceive(message: EmailMessage): void {
    this.received.push(message);
    const bridge = this.bridge();
    if (bridge === null) return;
    if (this.mode === 'acknowledge') bridge.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
    else if (this.mode === 'refuse') bridge.tell({ kind: 'negativeAcknowledgment', ackToken: message.ackToken });
    else if (this.mode === 'drop') bridge.tell({ kind: 'negativeAcknowledgment', ackToken: message.ackToken, drop: true });
  }
}

let systemCounter = 0;
function makeSystem(config?: ConfigObject): ActorSystem {
  let systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config !== undefined) systemOptions = systemOptions.withConfig(config);
  return ActorSystem.create(`email-bridge-${++systemCounter}`, systemOptions);
}

/** Fast timings so a test does not wait on production defaults. */
const fastImap = {
  host: 'imap.example.test',
  user: 'bridge',
  password: 'secret',
  pollIntervalMs: 25,
  acknowledgmentTimeoutMs: 5_000,
} as const;

/* -------------------------------- tests -------------------------------- */

describe('EmailBridgeActor — peer dependencies', () => {
  test('constructing an actor does not pull in the imapflow / nodemailer peer-deps', () => {
    // Neither package is installed; a construction-time import would throw.
    expect(() => new EmailBridgeActor(
      EmailBridgeOptions.create().withSmtp({ host: 'smtp.example.test' }),
    )).not.toThrow();
  });
});

describe('EmailBridgeActor — inbound sweep', () => {
  test('delivers unseen mail and skips what is already seen', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef);
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [
        textMail(1, 'fresh alert', 'disk is full'),
        textMail(2, 'old alert', 'already handled', true),
      ];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(120);

      expect(inbox.received.length).toBe(1);
      expect(inbox.received[0]!.subject).toBe('fresh alert');
      expect(inbox.received[0]!.text).toBe('disk is full');
      expect(inbox.received[0]!.from).toEqual({ name: 'Ops Bot', address: 'ops@example.test' });
      expect(inbox.received[0]!.to).toEqual([{ address: 'bridge@example.test' }]);
      expect(inbox.received[0]!.truncated).toBe(false);
      expect(inbox.received[0]!.mailbox).toBe('INBOX');
    } finally {
      await system.terminate();
    }
  });

  test('an acknowledgment marks the message seen', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef);
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(7, 'alert', 'body')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(150);

      expect(imapModule.last().flagAdds).toEqual([{ uid: '7', flags: ['\\Seen'] }]);
      // Settled, so later sweeps must not deliver it again.
      expect(inbox.received.length).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('move mode moves the message instead of flagging it', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef);
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(3, 'alert', 'body')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, onProcessed: 'move', moveToMailbox: 'Processed' })
          .withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(150);

      expect(imapModule.last().moves).toEqual([{ uid: '3', destination: 'Processed' }]);
      expect(imapModule.last().flagAdds).toEqual([]);
      expect(inbox.received.length).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  // Without this the very first settle fails, the message stays unflagged,
  // and the bridge redelivers it forever — with the move reported as an
  // ordinary warning.
  test('move mode creates the destination mailbox on connect', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, onProcessed: 'move', moveToMailbox: 'Processed' })
          .withTarget(inboxRef),
        imapModule,
      );
      system.spawn(() => actor, 'bridge');
      await sleep(80);

      expect(imapModule.last().mailboxCreates).toEqual(['Processed']);
      expect(actor.state).toBe('connected');
    } finally {
      await system.terminate();
    }
  });

  test('an already existing destination mailbox does not fail the connect', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      // A server rejects CREATE for a mailbox that is already there.
      imapModule.configureClient = (client) => { client.existingMailboxes.add('Processed'); };
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, onProcessed: 'move', moveToMailbox: 'Processed' })
          .withTarget(inboxRef),
        imapModule,
      );
      system.spawn(() => actor, 'bridge');
      await sleep(80);

      expect(actor.state).toBe('connected');
      expect(imapModule.clients.length).toBe(1); // no reconnect cycle
    } finally {
      await system.terminate();
    }
  });

  test('markSeen mode creates no mailbox', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
        imapModule,
      );
      system.spawn(() => actor, 'bridge');
      await sleep(80);

      expect(imapModule.last().mailboxCreates).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a refused message is left unflagged and redelivered', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef, 'refuse');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(9, 'poison', 'body')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(200);

      expect(imapModule.last().flagAdds).toEqual([]);
      expect(inbox.received.length).toBeGreaterThan(1);
      expect(inbox.received.every((m) => m.uid === 9)).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('a refusal with drop settles the message without processing it', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef, 'drop');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(11, 'poison', 'body')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(150);

      expect(imapModule.last().flagAdds).toEqual([{ uid: '11', flags: ['\\Seen'] }]);
      expect(inbox.received.length).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('an unacknowledged message is not redelivered until its deadline passes', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(5, 'alert', 'body')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, acknowledgmentTimeoutMs: 120 })
          .withTarget(inboxRef),
        imapModule,
      );
      system.spawn(() => actor, 'bridge');

      // Several sweeps happen inside the deadline; the message is in flight,
      // so none of them delivers it a second time.
      await sleep(90);
      expect(inbox.received.length).toBe(1);

      // Past the deadline the bridge gives up waiting and the sweep finds it again.
      await sleep(180);
      expect(inbox.received.length).toBeGreaterThan(1);
      expect(imapModule.last().flagAdds).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('an EXISTS notification wakes the loop before the poll interval', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef);
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      const actor = new TestEmailBridgeActor(
        // A poll interval far longer than the test: only the EXISTS wake-up
        // can deliver within it.
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, pollIntervalMs: 60_000 })
          .withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(60);
      expect(inbox.received.length).toBe(0);

      imapModule.last().addMail(textMail(21, 'urgent', 'now'));
      imapModule.last().fireExists();
      await sleep(80);

      expect(inbox.received.length).toBe(1);
      expect(inbox.received[0]!.subject).toBe('urgent');
      expect(imapModule.last().idleCalls).toBeGreaterThan(0);
    } finally {
      await system.terminate();
    }
  });

  test('a server without IDLE is polled instead', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef);
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.configureClient = (client) => { client.capabilities = new Set(['IMAP4rev1']); };
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(60);

      imapModule.last().addMail(textMail(31, 'polled', 'body'));
      await sleep(100);

      expect(imapModule.last().idleCalls).toBe(0);
      expect(imapModule.last().noopCalls).toBeGreaterThan(0);
      expect(inbox.received.map((m) => m.subject)).toContain('polled');
    } finally {
      await system.terminate();
    }
  });

  test('disableIdle forces polling even when the server offers IDLE', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, disableIdle: true })
          .withTarget(inboxRef),
        imapModule,
      );
      system.spawn(() => actor, 'bridge');
      await sleep(120);

      expect(imapModule.last().idleCalls).toBe(0);
      expect(imapModule.last().noopCalls).toBeGreaterThan(0);
    } finally {
      await system.terminate();
    }
  });

  test('an unreadable message does not stall the ones behind it', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef);
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(1, 'broken', 'x'), textMail(2, 'fine', 'y')];
      imapModule.configureClient = (client) => { client.failFetchForUid = 1; };
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(150);

      expect(inbox.received.map((m) => m.subject)).toContain('fine');
      // The connection survived — a bad message is not an outage.
      expect(actor.state).toBe('connected');
    } finally {
      await system.terminate();
    }
  });

  test('a body past the cap is cut and flagged as truncated', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => bridgeRef);
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(4, 'huge', 'abcdefghij')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, maxMessageBytes: 4 })
          .withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(150);

      expect(inbox.received.length).toBe(1);
      expect(inbox.received[0]!.text).toBe('abcd');
      expect(inbox.received[0]!.truncated).toBe(true);
      expect(inbox.received[0]!.size).toBe(10);
    } finally {
      await system.terminate();
    }
  });
});

describe('EmailBridgeActor — connection lifecycle', () => {
  test('a dropped connection reconnects and redelivers unsettled mail', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(8, 'survivor', 'body')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, acknowledgmentTimeoutMs: 60_000 })
          .withTarget(inboxRef)
          .withReconnect({ initialDelayMs: 20, maxDelayMs: 20, randomFactor: 0 }),
        imapModule,
      );
      system.spawn(() => actor, 'bridge');
      await sleep(120);
      expect(inbox.received.length).toBe(1);
      expect(imapModule.clients.length).toBe(1);

      imapModule.last().fireClose();
      await sleep(200);

      // A second client was built, and the never-acknowledged message —
      // still unflagged — came back on its first sweep.
      expect(imapModule.clients.length).toBeGreaterThan(1);
      expect(inbox.received.length).toBeGreaterThan(1);
      expect(inbox.received.every((m) => m.uid === 8)).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('an acknowledgment after a mailbox renumbering is not applied', async () => {
    const system = makeSystem();
    try {
      let bridgeRef: ActorRef<EmailBridgeCommand> | null = null;
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      imapModule.seed = () => [textMail(6, 'alert', 'body')];
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ ...fastImap, pollIntervalMs: 60_000, acknowledgmentTimeoutMs: 60_000 })
          .withTarget(inboxRef),
        imapModule,
      );
      bridgeRef = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(120);
      expect(inbox.received.length).toBe(1);

      // The server renumbered the mailbox: this UID is now someone else's mail.
      imapModule.last().uidValidity = 99n;
      bridgeRef.tell({ kind: 'acknowledgment', ackToken: inbox.received[0]!.ackToken });
      await sleep(60);

      expect(imapModule.last().flagAdds).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('stopping the actor logs out and does not reconnect', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      const imapModule = new FakeImapModule();
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap(fastImap)
          .withTarget(inboxRef)
          .withReconnect({ initialDelayMs: 10, maxDelayMs: 10, randomFactor: 0 }),
        imapModule,
      );
      const ref = system.spawn(() => actor, 'bridge');
      await sleep(80);
      const client = imapModule.last();

      ref.stop();
      // Long enough for postStop to run and the loop to unwind.  The count is
      // taken after that, not before the stop: `stop()` travels through the
      // mailbox, so a sweep may still start in between and prove nothing.
      await sleep(100);
      const sweepsAfterStop = client.searches.length;
      await sleep(150); // several poll intervals

      expect(client.logoutCalls).toBe(1);
      expect(imapModule.clients.length).toBe(1);              // no reconnect
      expect(client.searches.length).toBe(sweepsAfterStop);   // loop stopped
    } finally {
      await system.terminate();
    }
  });
});

describe('EmailBridgeActor — outbound', () => {
  test('sends through the pooled transport and applies the default From', async () => {
    const system = makeSystem();
    try {
      const smtpModule = new FakeNodemailerModule();
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withSmtp({
          host: 'smtp.example.test',
          from: 'bridge@example.test',
        }),
        new FakeImapModule(),
        smtpModule,
      );
      const ref = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(60);

      ref.tell({ kind: 'send', email: { to: 'ops@example.test', subject: 'hi', text: 'body' } });
      await sleep(60);

      const transporter = smtpModule.last();
      expect(transporter.options.pool).toBe(true);
      expect(transporter.options.port).toBe(587);
      expect(transporter.verifyCalls).toBe(1);
      expect(transporter.sent.length).toBe(1);
      expect(transporter.sent[0]!.from).toBe('bridge@example.test');
      expect(transporter.sent[0]!.to).toBe('ops@example.test');
      expect(transporter.sent[0]!.subject).toBe('hi');
      // Send-only bridge: no IMAP client was ever built.
      expect(actor.imapModule.clients.length).toBe(0);
    } finally {
      await system.terminate();
    }
  });

  test('an explicit From wins over the configured default', async () => {
    const system = makeSystem();
    try {
      const smtpModule = new FakeNodemailerModule();
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withSmtp({ host: 'smtp.example.test', from: 'default@example.test' }),
        new FakeImapModule(),
        smtpModule,
      );
      const ref = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(60);

      ref.tell({ kind: 'send', email: { to: 'ops@example.test', from: 'alerts@example.test' } });
      await sleep(60);

      expect(smtpModule.last().sent[0]!.from).toBe('alerts@example.test');
    } finally {
      await system.terminate();
    }
  });

  test('a message the server rejects is dropped, not retried forever', async () => {
    const system = makeSystem();
    try {
      const smtpModule = new FakeNodemailerModule();
      smtpModule.configureTransporter = (transporter) => {
        transporter.sendFailure = Object.assign(new Error('550 no such user'), { responseCode: 550 });
      };
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withSmtp({ host: 'smtp.example.test' }),
        new FakeImapModule(),
        smtpModule,
      );
      const ref = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(60);

      ref.tell({ kind: 'send', email: { to: 'ghost@example.test' } });
      await sleep(80);

      // Dropped: the pool stayed up and nothing was re-queued.
      expect(actor.state).toBe('connected');
      expect(actor.bufferedOutbound).toBe(0);
      expect(smtpModule.transporters.length).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('a connection-level failure re-queues the message and it goes out after reconnect', async () => {
    const system = makeSystem();
    try {
      const smtpModule = new FakeNodemailerModule();
      let first = true;
      smtpModule.configureTransporter = (transporter) => {
        if (first) {
          first = false;
          transporter.sendFailure = Object.assign(new Error('connection lost'), { code: 'ECONNECTION' });
        }
      };
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withSmtp({ host: 'smtp.example.test' })
          .withReconnect({ initialDelayMs: 20, maxDelayMs: 20, randomFactor: 0 }),
        new FakeImapModule(),
        smtpModule,
      );
      const ref = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(60);

      ref.tell({ kind: 'send', email: { to: 'ops@example.test', subject: 'retried' } });
      await sleep(250);

      // The second transport carries the message the first one could not.
      expect(smtpModule.transporters.length).toBeGreaterThan(1);
      expect(smtpModule.last().sent.map((m) => m.subject)).toEqual(['retried']);
    } finally {
      await system.terminate();
    }
  });

  test('a send buffered during an outage goes out once the transport is back', async () => {
    const system = makeSystem();
    try {
      const smtpModule = new FakeNodemailerModule();
      let first = true;
      smtpModule.configureTransporter = (transporter) => {
        if (first) {
          first = false;
          transporter.verifyFailure = new Error('smtp unreachable');
        }
      };
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withSmtp({ host: 'smtp.example.test' })
          .withReconnect({ initialDelayMs: 40, maxDelayMs: 40, randomFactor: 0 }),
        new FakeImapModule(),
        smtpModule,
      );
      const ref = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(20);

      // The first connect failed, so the bridge is between attempts here.
      ref.tell({ kind: 'send', email: { to: 'ops@example.test', subject: 'buffered' } });
      await sleep(250);

      expect(smtpModule.last().sent.map((m) => m.subject)).toEqual(['buffered']);
    } finally {
      await system.terminate();
    }
  });

  test('a send without an smtp side is refused rather than buffered', async () => {
    const system = makeSystem();
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create().withImap(fastImap).withTarget(inboxRef),
      );
      const ref = system.spawn(() => actor, 'bridge') as ActorRef<EmailBridgeCommand>;
      await sleep(60);

      ref.tell({ kind: 'send', email: { to: 'ops@example.test' } });
      await sleep(60);

      expect(actor.bufferedOutbound).toBe(0);
      expect(actor.smtpModule.transporters.length).toBe(0);
    } finally {
      await system.terminate();
    }
  });
});

describe('EmailBridgeActor — options', () => {
  test('constructor beats HOCON, HOCON beats the built-in defaults', async () => {
    const system = makeSystem({
      'actor-ts': {
        io: {
          broker: {
            'email-bridge': {
              imap: {
                host: 'imap.from-hocon.test',
                port: 1993,
                mailbox: 'Alerts',
                user: 'hocon-user',
                password: 'hocon-secret',
                onProcessed: 'move',
                moveToMailbox: 'Done',
                disableIdle: true,
                pollIntervalMs: 45,
                maxMessageBytes: 2048,
              },
              smtp: {
                host: 'smtp.from-hocon.test',
                port: 2525,
                from: 'hocon@example.test',
                maxConnections: 3,
              },
            },
          },
        },
      },
    });
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');

      // The constructor supplies the whole `imap` group, so it replaces the
      // HOCON one wholesale — nested groups do not merge field by field.
      const actor = new TestEmailBridgeActor(
        EmailBridgeOptions.create()
          .withImap({ host: 'imap.from-code.test', pollIntervalMs: 60_000 })
          .withTarget(inboxRef),
      );
      system.spawn(() => actor, 'bridge');
      await sleep(60);

      const resolved = actor.resolvedOptions;
      expect(resolved.imap?.host).toBe('imap.from-code.test');
      expect(resolved.imap?.mailbox).toBeUndefined();
      // The smtp group came from HOCON untouched.
      expect(resolved.smtp?.host).toBe('smtp.from-hocon.test');
      expect(resolved.smtp?.port).toBe(2525);
      expect(resolved.smtp?.from).toBe('hocon@example.test');
      expect(resolved.smtp?.maxConnections).toBe(3);
      // Defaults are applied where the fields are read, so they stay unset here.
      expect(resolved.imap?.port).toBeUndefined();
      expect(actor.smtpModule.last().options.port).toBe(2525);
      expect(actor.imapModule.last().options.port).toBe(993);
    } finally {
      await system.terminate();
    }
  });

  test('every imap and smtp leaf is readable from HOCON', async () => {
    const system = makeSystem({
      'actor-ts': {
        io: {
          broker: {
            'email-bridge': {
              imap: {
                host: 'imap.example.test',
                port: 1143,
                secure: false,
                user: 'reader',
                password: 'pw',
                mailbox: 'Watched',
                onProcessed: 'move',
                moveToMailbox: 'Archive',
                disableIdle: true,
                maxIdleTimeMs: 111,
                pollIntervalMs: 222,
                maxMessageBytes: 333,
                acknowledgmentTimeoutMs: 444,
              },
              smtp: {
                host: 'smtp.example.test',
                port: 2465,
                secure: true,
                user: 'sender',
                password: 'pw2',
                from: 'noreply@example.test',
                maxConnections: 7,
                maxMessages: 8,
              },
            },
          },
        },
      },
    });
    try {
      const inbox = new InboxActor(() => null, 'silent');
      const inboxRef = system.spawn(() => inbox, 'inbox');
      const actor = new TestEmailBridgeActor(EmailBridgeOptions.create().withTarget(inboxRef));
      system.spawn(() => actor, 'bridge');
      await sleep(60);

      expect(actor.resolvedOptions.imap).toEqual({
        host: 'imap.example.test',
        port: 1143,
        secure: false,
        user: 'reader',
        password: 'pw',
        mailbox: 'Watched',
        onProcessed: 'move',
        moveToMailbox: 'Archive',
        disableIdle: true,
        maxIdleTimeMs: 111,
        pollIntervalMs: 222,
        maxMessageBytes: 333,
        acknowledgmentTimeoutMs: 444,
      });
      expect(actor.resolvedOptions.smtp).toEqual({
        host: 'smtp.example.test',
        port: 2465,
        secure: true,
        user: 'sender',
        password: 'pw2',
        from: 'noreply@example.test',
        maxConnections: 7,
        maxMessages: 8,
      });
    } finally {
      await system.terminate();
    }
  });
});
