/**
 * EmailBridgeActor runner — drives the bridge against GreenMail (#1133).
 *
 * The suite is self-contained: the bridge's own SMTP half posts the
 * message that its IMAP half then has to pick up, so no scenario needs a
 * second mail client to set up its fixture.
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import {
  EmailBridgeActor,
  type EmailBridgeCommand,
  type EmailMessage,
} from '../../../../src/io/broker/EmailBridgeActor.js';
import {
  EmailBridgeOptions,
  type EmailImapOptionsType,
} from '../../../../src/io/broker/EmailBridgeOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioContext } from '../lib/Scenario.js';
import { scenario as sendReceiveScenario } from './scenarios/01-send-and-receive.js';
import { scenario as redeliveryScenario } from './scenarios/02-no-acknowledgment-redelivers.js';
import { scenario as pollingScenario } from './scenarios/03-polling-fallback.js';
import { scenario as moveScenario } from './scenarios/04-move-mode.js';

export interface EmailContext extends BrokerScenarioContext {
  readonly host: string;
  readonly smtpPort: number;
  readonly imapPort: number;
  readonly user: string;
  readonly password: string;
  readonly address: string;
  readonly system: ActorSystem;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

/**
 * Collects inbound mail.  `acknowledge` is the normal at-least-once
 * consumer; `silent` never answers, which is how a scenario proves an
 * unacknowledged message comes back.
 */
export class InboxActor extends Actor<EmailMessage> {
  readonly received: EmailMessage[] = [];
  bridge: ActorRef<EmailBridgeCommand> | null = null;

  constructor(private readonly mode: 'acknowledge' | 'silent' = 'acknowledge') { super(); }

  override onReceive(message: EmailMessage): void {
    this.received.push(message);
    if (this.mode === 'acknowledge') {
      this.bridge?.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
    }
  }

  /** Messages seen so far carrying this Message-ID. */
  countOf(messageId: string): number {
    return this.received.filter((m) => m.messageId === messageId).length;
  }
}

/**
 * Spawn a bridge plus its inbox, wired to each other.  `imapOverrides`
 * tunes the inbound half per scenario; the SMTP half is the same
 * everywhere.
 */
export function spawnBridge(
  context: EmailContext,
  options: {
    readonly mode?: 'acknowledge' | 'silent';
    readonly imap?: Partial<EmailImapOptionsType>;
  } = {},
): {
  readonly bridge: ActorRef<EmailBridgeCommand>;
  readonly inbox: InboxActor;
  readonly stop: () => void;
} {
  const inbox = new InboxActor(options.mode ?? 'acknowledge');
  const inboxRef = context.system.spawnAnonymous(() => inbox) as unknown as ActorRef<EmailMessage>;

  const actor = new EmailBridgeActor(
    EmailBridgeOptions.create()
      .withImap({
        host: context.host,
        port: context.imapPort,
        // GreenMail's test ports are plain-text; TLS is not what these
        // scenarios are proving.
        secure: false,
        user: context.user,
        password: context.password,
        pollIntervalMs: 1_000,
        acknowledgmentTimeoutMs: 30_000,
        ...options.imap,
      })
      .withSmtp({
        host: context.host,
        port: context.smtpPort,
        secure: false,
        user: context.user,
        password: context.password,
        from: context.address,
      })
      .withTarget(inboxRef)
      .withReconnect({ initialDelayMs: 200, maxDelayMs: 2_000 }),
  );
  const bridgeRef = context.system.spawnAnonymous(() => actor) as unknown as ActorRef<EmailBridgeCommand>;
  inbox.bridge = bridgeRef;

  return {
    bridge: bridgeRef,
    inbox,
    stop: () => {
      (bridgeRef as unknown as { stop(): void }).stop();
      (inboxRef as unknown as { stop(): void }).stop();
    },
  };
}

async function main(): Promise<void> {
  const host = requireEnv('EMAIL_HOST');
  const smtpPort = Number(requireEnv('EMAIL_SMTP_PORT'));
  const imapPort = Number(requireEnv('EMAIL_IMAP_PORT'));

  // Both halves, because both are load-bearing and GreenMail brings its
  // services up one after another.
  await waitForPort(host, smtpPort, { description: 'GreenMail SMTP', deadlineMs: 30_000 });
  await waitForPort(host, imapPort, { description: 'GreenMail IMAP', deadlineMs: 30_000 });

  const system = ActorSystem.create('email-runner', ActorSystemOptions.create()
    .withLogger(new JsonLogger()).withLogLevel(LogLevel.Info));
  process.on('SIGTERM', () => { void system.terminate(); });

  const context: EmailContext = {
    env: process.env,
    host,
    smtpPort,
    imapPort,
    user: requireEnv('EMAIL_USER'),
    password: requireEnv('EMAIL_PASSWORD'),
    address: requireEnv('EMAIL_ADDRESS'),
    system,
  };

  try {
    const scenarios: BrokerScenario<EmailContext>[] = [
      sendReceiveScenario,
      redeliveryScenario,
      pollingScenario,
      moveScenario,
    ];
    await runScenarios(scenarios, context);
  } finally {
    await system.terminate();
  }
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
