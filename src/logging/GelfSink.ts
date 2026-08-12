import { compressorFor } from '../persistence/object-storage/Compression.js';
import { getTcpBackend } from '../runtime/tcp/index.js';
import type { TcpSocketLike, TlsTransportOptionsType } from '../runtime/tcp/TcpBackend.js';
import { Lazy } from '../util/Lazy.js';
import { BatchingSink, SinkDeliveryError } from './BatchingSink.js';
import {
  chunkGelfDatagram,
  DEFAULT_GELF_MAX_CHUNK_BYTES,
  GelfMessageTooLargeError,
  newGelfMessageId,
} from './GelfChunking.js';
import { encodeGelf, gelfPayloadFor } from './GelfPayload.js';
import {
  DEFAULT_GELF_COMPRESSION,
  DEFAULT_GELF_HOST,
  DEFAULT_GELF_MIN_LEVEL,
  DEFAULT_GELF_PORT,
  DEFAULT_GELF_PROTOCOL,
  DEFAULT_GELF_REQUEST_TIMEOUT_MS,
  GelfSinkOptionsValidator,
  type GelfCompression,
  type GelfProtocol,
  type GelfSinkOptions,
  type GelfSinkOptionsType,
} from './GelfSinkOptions.js';
import { postToEndpoint, type FetchLike } from './HttpDelivery.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSinkContext } from './LogSink.js';

const ENCODER = new TextEncoder();

/** One GELF message on its way out.  The three protocols differ only here. */
interface GelfTransport {
  send(message: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Ships records to Graylog as GELF, over UDP, TCP or HTTP.
 *
 *     const gelfSink = new GelfSink(GelfSinkOptions.create()
 *       .withHost('graylog.internal')
 *       .withProtocol('udp'));
 *
 * **Why a native sink when there is an OTLP one.**  Graylog's
 * OpenTelemetry input accepts OTLP over **gRPC only**, so the framework's
 * OTLP/HTTP sink cannot reach it at all without a collector in between.
 * GELF also lands structured fields as first-class searchable keys, where
 * the OTLP path prefixes them into `otel_attributes_*`.
 *
 * **No SDK.**  GELF is a JSON document; the transports are a datagram, a
 * null-delimited stream, and an HTTP POST.
 *
 * **Fields from a remote peer are not trusted** (#573).  Names are
 * sanitised to what the spec allows, the forbidden `_id` is dropped, and a
 * field that would collide with one of GELF's own top-level keys —
 * overwriting the timestamp, level or message — is dropped too.
 */
export class GelfSink extends BatchingSink {
  private readonly protocol: GelfProtocol;
  private readonly host: string;
  private readonly port: number;
  private readonly url: string | undefined;
  private readonly configuredHostName: string | undefined;
  private readonly compression: GelfCompression;
  private readonly maxChunkBytes: number;
  private readonly tls: TlsTransportOptionsType | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike | undefined;
  private hostName: string;
  private transport: GelfTransport | undefined;

  constructor(options: GelfSinkOptions = {}) {
    const settings = validated(options);
    super('gelf', settings.minLevel ?? DEFAULT_GELF_MIN_LEVEL, settings.delivery);
    this.protocol = settings.protocol ?? DEFAULT_GELF_PROTOCOL;
    this.host = settings.host ?? DEFAULT_GELF_HOST;
    this.port = settings.port ?? DEFAULT_GELF_PORT;
    this.url = settings.url;
    this.configuredHostName = settings.hostName;
    this.hostName = settings.hostName ?? osHostName() ?? 'actor-ts';
    this.compression = settings.compression ?? DEFAULT_GELF_COMPRESSION;
    this.maxChunkBytes = settings.maxChunkBytes ?? DEFAULT_GELF_MAX_CHUNK_BYTES;
    this.tls = settings.tls;
    this.requestTimeoutMs = settings.requestTimeoutMs ?? DEFAULT_GELF_REQUEST_TIMEOUT_MS;
    this.fetchFn = settings.fetchFn;
  }

  override attach(context: LogSinkContext): void {
    super.attach(context);
    // Without an OS hostname to go by, the system name is a better answer
    // than a placeholder: it at least says which application these are.
    if (this.configuredHostName === undefined && osHostName() === undefined && context.systemName !== undefined) {
      this.hostName = context.systemName;
    }
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    const transport = this.transport ??= this.createTransport();
    for (const record of records) {
      const message = encodeGelf(gelfPayloadFor(record, this.hostName));
      await transport.send(message);
    }
  }

  protected override async closeTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    await transport?.close();
  }

  /**
   * Build the transport for the configured protocol.
   *
   * `protected` so a test can substitute one and assert the exact bytes
   * that would go on the wire — the wire format is the whole product here,
   * and it should not need a socket to check.
   */
  protected createTransport(): GelfTransport {
    if (this.protocol === 'tcp') {
      return new TcpGelfTransport(this.host, this.port, this.tls);
    }
    if (this.protocol === 'http') {
      return new HttpGelfTransport(this.url!, this.requestTimeoutMs, this.fetchFn);
    }
    return new UdpGelfTransport(this.host, this.port, this.compression, this.maxChunkBytes, this.reporter);
  }
}

/* ------------------------------- UDP ------------------------------------ */

export type DgramSocketLike = {
  send(message: Uint8Array, port: number, host: string, callback: (error?: Error) => void): void;
  close(callback?: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  unref?(): void;
};

type DgramModule = {
  createSocket(type: 'udp4' | 'udp6'): DgramSocketLike;
};

const dgramLazy: Lazy<Promise<DgramModule>> = Lazy.of(async () => {
  const name = 'node:dgram';
  return (await import(name)) as DgramModule;
});

/**
 * Fire-and-forget datagrams, optionally gzipped, chunked when they are too
 * big for one packet.
 *
 * The socket is never bound: this only sends.  `UdpSocketActor` exists for
 * two-way datagram traffic and binds a local port for replies, and it also
 * logs its own failures through `this.log` — which is precisely the loop a
 * sink must not close.
 */
export class UdpGelfTransport implements GelfTransport {
  private socket: DgramSocketLike | undefined;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly compression: GelfCompression,
    private readonly maxChunkBytes: number,
    private readonly reporter: { report(reason: string, detail?: unknown): void },
    /**
     * How the socket is obtained.  Injectable so the bytes this transport
     * puts on the wire — compression, chunk headers, framing — can be
     * asserted exactly, without a socket in the test.
     */
    private readonly openSocket: () => Promise<DgramSocketLike> = () => defaultUdpSocket(host, reporter),
  ) {}

  async send(message: string): Promise<void> {
    const socket = await this.ensureSocket();
    const encoded = ENCODER.encode(message);
    // The server detects gzip from the magic bytes — nothing to declare.
    const payload: Uint8Array = this.compression === 'gzip'
      ? await compressorFor('gzip').compress(encoded)
      : encoded;
    let datagrams: Uint8Array[];
    try {
      datagrams = chunkGelfDatagram(payload, newGelfMessageId(), this.maxChunkBytes);
    } catch (error) {
      if (error instanceof GelfMessageTooLargeError) {
        // Retrying cannot shrink it, and UDP offers nothing else to try.
        this.reporter.report('record too large for GELF over UDP', error.message);
        throw new SinkDeliveryError(error.message, false);
      }
      throw error;
    }
    for (const datagram of datagrams) {
      await new Promise<void>((resolve, reject) => {
        socket.send(datagram, this.port, this.host, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined) return;
    await new Promise<void>((resolve) => socket.close(resolve));
  }

  private async ensureSocket(): Promise<DgramSocketLike> {
    this.socket ??= await this.openSocket();
    return this.socket;
  }
}

async function defaultUdpSocket(
  host: string,
  reporter: { report(reason: string, detail?: unknown): void },
): Promise<DgramSocketLike> {
  const dgram = await dgramLazy.get();
  // A literal colon is an IPv6 address; a hostname resolves through the
  // udp4 socket either way.
  const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  // An unhandled 'error' on a dgram socket is fatal to the process, and a
  // logging sink has no business ending one.
  socket.on('error', (error) => reporter.report('UDP socket error', error));
  // Never keep a program alive for a fire-and-forget log socket.
  socket.unref?.();
  return socket;
}

/* ------------------------------- TCP ------------------------------------ */

/**
 * One long-lived connection, one null byte after each message.
 *
 * GELF-over-TCP supports neither compression nor chunking, for the same
 * reason: the null byte is the frame delimiter, so anything that could
 * contain one cannot be sent raw.
 */
class TcpGelfTransport implements GelfTransport {
  private socket: TcpSocketLike | undefined;
  private connecting: Promise<TcpSocketLike> | undefined;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly tls: TlsTransportOptionsType | undefined,
  ) {}

  async send(message: string): Promise<void> {
    const socket = await this.ensureConnected();
    // A newline inside a message is fine; a null byte would forge a frame
    // boundary, so it is the one character that cannot survive.
    socket.write(ENCODER.encode(`${message.replace(/\0/g, '')}\0`));
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
      // Retryable: a Graylog that is restarting is the ordinary case, and
      // the batch should survive it.
      const reason = error instanceof Error ? error.message : String(error);
      throw new SinkDeliveryError(`GELF TCP connect to ${this.host}:${this.port} failed: ${reason}`, true);
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
        // Graylog says nothing back on a GELF input.
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

/* ------------------------------- HTTP ----------------------------------- */

/** One POST per message — a GELF HTTP input takes a single document. */
class HttpGelfTransport implements GelfTransport {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchLike | undefined,
  ) {}

  async send(message: string): Promise<void> {
    await postToEndpoint({
      url: this.url,
      headers: { 'content-type': 'application/json' },
      body: message,
      timeoutMs: this.timeoutMs,
      ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
    });
  }

  async close(): Promise<void> {
    /* Stateless. */
  }
}

/* ----------------------------- internals -------------------------------- */

/**
 * Spread and validate before `super()` — a derived constructor cannot run
 * `this`-touching statements first.
 */
function validated(options: GelfSinkOptions): Partial<GelfSinkOptionsType> {
  const settings = { ...(options as Partial<GelfSinkOptionsType>) };
  new GelfSinkOptionsValidator().validate(settings);
  return settings;
}

/**
 * The machine's hostname, when the runtime offers one.
 *
 * Read from the environment rather than `node:os` so this stays
 * synchronous and dependency-free; every platform sets one of these, and
 * the field has a sensible fallback when none does.
 */
function osHostName(): string | undefined {
  const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const name = environment?.['HOSTNAME'] ?? environment?.['COMPUTERNAME'];
  return name !== undefined && name !== '' ? name : undefined;
}
