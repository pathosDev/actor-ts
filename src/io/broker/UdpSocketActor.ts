import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { resolveSettings } from '../../util/OptionsBuilder.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';
import type { UdpSocketOptions } from './UdpSocketOptions.js';

/** Inbound datagram delivered to the target actor. */
export interface UdpDatagram {
  readonly payload: Uint8Array;
  readonly remoteHost: string;
  readonly remotePort: number;
}

/** Outbound datagram — explicit destination (UDP is not connection-oriented). */
export interface UdpOutbound {
  readonly payload: Uint8Array | string;
  readonly host: string;
  readonly port: number;
}

export interface UdpSocketActorSettings extends BrokerCommonSettings {
  /** Local bind address.  Default: `'0.0.0.0'`. */
  readonly bindHost?: string;
  /** Local port.  `0` (default) lets the OS pick. */
  readonly bindPort?: number;
  /** IPv4 (`'udp4'`) or IPv6 (`'udp6'`).  Default: `'udp4'`. */
  readonly type?: 'udp4' | 'udp6';
  /** Subscriber for inbound datagrams.  Required. */
  readonly target?: ActorRef<UdpDatagram>;
}

export type UdpSocketCmd = { readonly kind: 'send'; readonly datagram: UdpOutbound };

/**
 * UDP-socket actor.  Uses `node:dgram` (built-in everywhere).  No
 * connection lifecycle in the TCP sense; we treat "bound" as
 * `connected` and "unbound" as `disconnected`, so the base class'
 * lifecycle events still apply (`BrokerConnected` fires once the
 * socket is bound).
 */
export class UdpSocketActor
  extends BrokerActor<UdpSocketActorSettings, UdpSocketCmd, UdpOutbound> {
  private socket: DgramSocket | null = null;
  private actualPort = 0;

  constructor(options: UdpSocketOptions | Partial<UdpSocketActorSettings> = {}) { super(resolveSettings(options)); }

  protected configKey(): string { return ConfigKeys.io.broker.udp; }
  protected builtInDefaults(): Partial<UdpSocketActorSettings> {
    return { bindHost: '0.0.0.0', bindPort: 0, type: 'udp4' };
  }
  protected readSettingsFromConfig(c: Config): Partial<UdpSocketActorSettings> {
    const out: { -readonly [K in keyof UdpSocketActorSettings]?: UdpSocketActorSettings[K] } = {};
    if (c.hasPath('bindHost')) out.bindHost = c.getString('bindHost');
    if (c.hasPath('bindPort')) out.bindPort = c.getInt('bindPort');
    if (c.hasPath('type')) out.type = c.getString('type') as 'udp4' | 'udp6';
    return out;
  }
  protected requiredSettings(): ReadonlyArray<keyof UdpSocketActorSettings> {
    return ['target'];
  }
  protected endpointLabel(): string {
    return `${this.settings.type}://${this.settings.bindHost}:${this.actualPort || this.settings.bindPort}`;
  }

  /** OS-assigned port after `bind` (0 before, real number after). */
  get boundPort(): number { return this.actualPort; }

  protected async connectImpl(): Promise<void> {
    const dgram = await dgramLazy.get();
    const sock = dgram.createSocket(this.settings.type ?? 'udp4');
    return new Promise<void>((resolve, reject) => {
      let done = false;
      sock.once('listening', () => {
        if (done) return;
        done = true;
        sock.removeAllListeners('error');
        this.socket = sock;
        const addr = sock.address();
        this.actualPort = addr.port;
        sock.on('message', (msg, rinfo) => {
          this.settings.target?.tell({
            payload: msg, remoteHost: rinfo.address, remotePort: rinfo.port,
          });
        });
        sock.on('error', (e) => this.handleConnectionLost(e));
        resolve();
      });
      sock.once('error', (e: Error) => {
        if (done) return;
        done = true;
        reject(e);
      });
      sock.bind(this.settings.bindPort ?? 0, this.settings.bindHost);
    });
  }

  protected async disconnectImpl(): Promise<void> {
    if (!this.socket) return;
    const sock = this.socket;
    this.socket = null;
    this.actualPort = 0;
    return new Promise<void>((resolve) => {
      sock.removeAllListeners();
      sock.close(() => resolve());
      setTimeout(() => resolve(), 500);
    });
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<UdpOutbound>): Promise<void> {
    if (!this.socket) throw new Error('UdpSocketActor: socket not bound');
    const bytes = env.payload.payload instanceof Uint8Array
      ? env.payload.payload
      : new TextEncoder().encode(env.payload.payload);
    return new Promise<void>((resolve, reject) => {
      this.socket!.send(bytes, env.payload.port, env.payload.host, (err) => {
        err ? reject(err) : resolve();
      });
    });
  }

  override onReceive(cmd: UdpSocketCmd): void {
    if (cmd.kind === 'send') this.enqueueOutbound(cmd.datagram);
  }
}

/* ---------------------------- internals --------------------------------- */

interface DgramSocket {
  on(event: 'message', cb: (msg: Uint8Array, rinfo: { address: string; port: number }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  once(event: 'listening', cb: () => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  bind(port: number, host?: string): void;
  send(msg: Uint8Array, port: number, host: string, cb: (err?: Error) => void): void;
  close(cb?: () => void): void;
  address(): { port: number; address: string };
}

interface DgramModule {
  createSocket(type: 'udp4' | 'udp6'): DgramSocket;
}

const dgramLazy: Lazy<Promise<DgramModule>> = Lazy.of(async () => {
  const name = 'node:dgram';
  return (await import(name)) as DgramModule;
});
