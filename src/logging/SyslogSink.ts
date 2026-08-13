import { getTcpBackend } from '../runtime/tcp/index.js';
import type { TcpSocketLike, TlsTransportOptionsType } from '../runtime/tcp/TcpBackend.js';
import { Lazy } from '../util/Lazy.js';
import { BatchingSink, SinkDeliveryError } from './BatchingSink.js';
import type { DgramSocketLike } from './GelfSink.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSinkContext } from './LogSink.js';
import {
  DEFAULT_SYSLOG_FACILITY,
  frameForStream,
  syslogMessageFor,
  type SyslogFraming,
} from './SyslogFrame.js';
import {
  DEFAULT_SYSLOG_FRAMING,
  DEFAULT_SYSLOG_HOST,
  DEFAULT_SYSLOG_MIN_LEVEL,
  DEFAULT_SYSLOG_PORT,
  DEFAULT_SYSLOG_TRANSPORT,
  SyslogSinkOptionsValidator,
  type SyslogSinkOptions,
  type SyslogSinkOptionsType,
  type SyslogTransport,
} from './SyslogSinkOptions.js';

const ENCODER = new TextEncoder();

/** One syslog message on its way out. */
interface SyslogWire {
  send(message: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Ships records as RFC 5424 syslog, over UDP, TCP or TLS.
 *
 *     const syslogSink = new SyslogSink(SyslogSinkOptions.create()
 *       .withHost('logs.internal')
 *       .withTransport('tls'));
 *
 * **The integration that needs no vendor.**  rsyslog, syslog-ng,
 * journald's forwarder, Papertrail and a long tail of network appliances
 * all speak it, so one sink covers the destinations that have nothing else
 * in common.
 *
 * The frame is built in {@link syslogMessageFor}; this class is the
 * transport and the batching around it.
 */
export class SyslogSink extends BatchingSink {
  private readonly transport: SyslogTransport;
  private readonly host: string;
  private readonly port: number;
  private readonly facility: number;
  private readonly configuredAppName: string | undefined;
  private readonly framing: SyslogFraming;
  private readonly tls: TlsTransportOptionsType | undefined;
  private readonly processId: string;
  private hostName: string;
  private appName: string;
  private wire: SyslogWire | undefined;

  constructor(options: SyslogSinkOptions = {}) {
    const settings = validated(options);
    super('syslog', settings.minLevel ?? DEFAULT_SYSLOG_MIN_LEVEL, settings.delivery);
    this.transport = settings.transport ?? DEFAULT_SYSLOG_TRANSPORT;
    this.host = settings.host ?? DEFAULT_SYSLOG_HOST;
    this.port = settings.port ?? DEFAULT_SYSLOG_PORT;
    this.facility = settings.facility ?? DEFAULT_SYSLOG_FACILITY;
    this.configuredAppName = settings.appName;
    this.appName = settings.appName ?? 'actor-ts';
    this.hostName = settings.hostName ?? osHostName() ?? '';
    this.framing = settings.framing ?? DEFAULT_SYSLOG_FRAMING;
    this.tls = settings.tls;
    this.processId = processId();
  }

  override attach(context: LogSinkContext): void {
    super.attach(context);
    // APP-NAME is how a collector separates one service's records from
    // another's, so the system's name beats the library's.
    if (this.configuredAppName === undefined && context.systemName !== undefined) {
      this.appName = context.systemName;
    }
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    const wire = this.wire ??= this.createWire();
    for (const record of records) {
      await wire.send(syslogMessageFor(record, {
        facility: this.facility,
        hostName: this.hostName,
        appName: this.appName,
        processId: this.processId,
      }));
    }
  }

  protected override async closeTransport(): Promise<void> {
    const wire = this.wire;
    this.wire = undefined;
    await wire?.close();
  }

  /**
   * Build the wire for the configured transport.  `protected` so a test
   * can substitute one and assert the exact frame bytes without a socket.
   */
  protected createWire(): SyslogWire {
    if (this.transport === 'udp') {
      return new UdpSyslogWire(this.host, this.port, this.reporter);
    }
    return new StreamSyslogWire(
      this.host,
      this.port,
      this.framing,
      this.transport === 'tls' ? (this.tls ?? {}) : undefined,
    );
  }
}

/* ------------------------------- UDP ------------------------------------ */

type DgramModule = {
  createSocket(type: 'udp4' | 'udp6'): DgramSocketLike;
};

const dgramLazy: Lazy<Promise<DgramModule>> = Lazy.of(async () => {
  const name = 'node:dgram';
  return (await import(name)) as DgramModule;
});

/**
 * One datagram per message — the classic syslog transport, and the only
 * one where a message needs no framing at all: the datagram boundary *is*
 * the frame.
 */
class UdpSyslogWire implements SyslogWire {
  private socket: DgramSocketLike | undefined;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly reporter: { report(reason: string, detail?: unknown): void },
  ) {}

  async send(message: string): Promise<void> {
    const socket = await this.ensureSocket();
    const datagram = ENCODER.encode(message);
    await new Promise<void>((resolve, reject) => {
      socket.send(datagram, this.port, this.host, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined) return;
    await new Promise<void>((resolve) => socket.close(resolve));
  }

  private async ensureSocket(): Promise<DgramSocketLike> {
    if (this.socket !== undefined) return this.socket;
    const dgram = await dgramLazy.get();
    const socket = dgram.createSocket(this.host.includes(':') ? 'udp6' : 'udp4');
    // An unhandled 'error' on a dgram socket ends the process, and a log
    // sink has no business doing that.
    socket.on('error', (error) => this.reporter.report('UDP socket error', error));
    socket.unref?.();
    this.socket = socket;
    return socket;
  }
}

/* --------------------------- TCP and TLS -------------------------------- */

/**
 * One long-lived connection carrying framed messages.
 *
 * TLS is the same code path with credentials attached — `getTcpBackend`
 * already normalises that across the three runtimes.
 */
class StreamSyslogWire implements SyslogWire {
  private socket: TcpSocketLike | undefined;
  private connecting: Promise<TcpSocketLike> | undefined;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly framing: SyslogFraming,
    private readonly tls: TlsTransportOptionsType | undefined,
  ) {}

  async send(message: string): Promise<void> {
    const socket = await this.ensureConnected();
    socket.write(ENCODER.encode(frameForStream(message, this.framing)));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    socket?.end();
  }

  private async ensureConnected(): Promise<TcpSocketLike> {
    if (this.socket !== undefined) return this.socket;
    this.connecting ??= this.connect();
    try {
      return await this.connecting;
    } catch (error) {
      this.connecting = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      // Retryable: a collector being restarted is the ordinary case.
      throw new SinkDeliveryError(`syslog connect to ${this.host}:${this.port} failed: ${reason}`, true);
    }
  }

  private async connect(): Promise<TcpSocketLike> {
    const backend = await getTcpBackend();
    const socket = await backend.connect({
      host: this.host,
      port: this.port,
      ...(this.tls !== undefined ? { tls: this.tls } : {}),
      handlers: {
        onOpen: () => {},
        // A syslog collector says nothing back.
        onData: () => {},
        onClose: () => { this.forget(socket); },
        onError: () => { this.forget(socket); },
      },
    });
    this.socket = socket;
    this.connecting = undefined;
    return socket;
  }

  /** Drop a dead socket so the next send reconnects instead of writing into it. */
  private forget(socket: TcpSocketLike): void {
    if (this.socket === socket) this.socket = undefined;
    this.connecting = undefined;
  }
}

/* ----------------------------- internals -------------------------------- */

/**
 * Spread and validate before `super()` — a derived constructor cannot run
 * `this`-touching statements first.
 */
function validated(options: SyslogSinkOptions): Partial<SyslogSinkOptionsType> {
  const settings = { ...(options as Partial<SyslogSinkOptionsType>) };
  new SyslogSinkOptionsValidator().validate(settings);
  return settings;
}

/** The machine's hostname, when the runtime offers one through the environment. */
function osHostName(): string | undefined {
  const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const name = environment?.['HOSTNAME'] ?? environment?.['COMPUTERNAME'];
  return name !== undefined && name !== '' ? name : undefined;
}

/** `PROCID` — the process id where the runtime exposes one. */
function processId(): string {
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid;
  return typeof pid === 'number' ? String(pid) : '';
}
