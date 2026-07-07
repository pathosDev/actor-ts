import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';
import type { RedisStreamsOptions } from './RedisStreamsOptions.js';

/** Inbound entry from a Redis stream. */
export interface RedisStreamEntry {
  readonly stream: string;
  readonly id: string;          // e.g. '1689000000000-0'
  readonly fields: Readonly<Record<string, string>>;
}

/** Outbound publish — adds an entry to a Redis stream via XADD. */
export interface RedisStreamPublish {
  readonly stream: string;
  readonly fields: Readonly<Record<string, string>>;
  /** Optional `MAXLEN ~ N` cap.  Drops oldest when set. */
  readonly maxLenApprox?: number;
}

export interface RedisStreamsActorSettings extends BrokerCommonSettings {
  /** Redis URL (`'redis://host:6379'`). */
  readonly url?: string;
  /** Streams to consume. */
  readonly streams?: ReadonlyArray<string>;
  /** Consumer-group settings — required to consume.  When omitted only producing works. */
  readonly consumerGroup?: {
    readonly group: string;
    readonly consumer: string;
    /** Auto-create the group if missing.  Default: true. */
    readonly createIfMissing?: boolean;
  };
  /** Block timeout per XREADGROUP call in ms.  Default: 5_000. */
  readonly blockMs?: number;
  /** Subscriber for inbound entries.  Required to consume. */
  readonly target?: ActorRef<RedisStreamEntry>;
}

export type RedisStreamsCmd =
  | { readonly kind: 'publish'; readonly publish: RedisStreamPublish }
  | { readonly kind: 'ack'; readonly stream: string; readonly id: string };

/**
 * Redis-Streams actor.  Wraps `ioredis` (already a peer-dep used by
 * the cache layer).  Producer + optional consumer in one actor.
 *
 * Consumer mode uses `XREADGROUP` with a stable consumer name; entries
 * are delivered to `target` and are NOT auto-acked — the caller must
 * `tell({ kind: 'ack', stream, id })` after processing for at-least-
 * once semantics with crash-recovery.  For at-most-once, ack
 * immediately on delivery.
 */
export class RedisStreamsActor
  extends BrokerActor<RedisStreamsActorSettings, RedisStreamsCmd, RedisStreamPublish> {
  private redis: IoredisClientLike | null = null;
  private redisProducer: IoredisClientLike | null = null;
  private consumerLoopRunning = false;

  constructor(options: RedisStreamsOptions | Partial<RedisStreamsActorSettings> = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.redisStreams; }
  protected builtInDefaults(): Partial<RedisStreamsActorSettings> {
    return { blockMs: 5_000 };
  }
  protected readSettingsFromConfig(c: Config): Partial<RedisStreamsActorSettings> {
    const out: { -readonly [K in keyof RedisStreamsActorSettings]?: RedisStreamsActorSettings[K] } = {};
    if (c.hasPath('url')) out.url = c.getString('url');
    if (c.hasPath('streams')) out.streams = c.getStringList('streams');
    if (c.hasPath('blockMs')) out.blockMs = c.getDuration('blockMs');
    if (c.hasPath('consumerGroup')) {
      const g = c.getConfig('consumerGroup');
      out.consumerGroup = {
        group: g.getString('group'),
        consumer: g.getString('consumer'),
        createIfMissing: g.hasPath('createIfMissing') ? g.getBoolean('createIfMissing') : undefined,
      };
    }
    return out;
  }
  protected requiredSettings(): ReadonlyArray<keyof RedisStreamsActorSettings> { return ['url']; }
  protected endpointLabel(): string { return this.settings.url ?? '<unknown>'; }

  protected async connectImpl(): Promise<void> {
    const ioredis = await ioredisLazy.get();
    const Ctor = ioredis.default ?? (ioredis as unknown as IoredisCtor);
    this.redisProducer = new Ctor(this.settings.url!);
    if (this.settings.consumerGroup && this.settings.streams && this.settings.target) {
      this.redis = new Ctor(this.settings.url!);
      const cg = this.settings.consumerGroup;
      if (cg.createIfMissing ?? true) {
        for (const stream of this.settings.streams) {
          try { await this.redis.xgroup('CREATE', stream, cg.group, '$', 'MKSTREAM'); }
          catch (e) {
            // BUSYGROUP = group already exists; ignore.  Anything else → log.
            if (!(e as Error).message.includes('BUSYGROUP')) {
              this.log.warn(`xgroup CREATE failed for '${stream}/${cg.group}': ${(e as Error).message}`);
            }
          }
        }
      }
      this.consumerLoopRunning = true;
      void this.consumerLoop();
    }
  }

  protected async disconnectImpl(): Promise<void> {
    this.consumerLoopRunning = false;
    try { await this.redisProducer?.quit(); } catch { /* ignore */ }
    try { await this.redis?.quit(); } catch { /* ignore */ }
    this.redisProducer = null;
    this.redis = null;
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<RedisStreamPublish>): Promise<void> {
    if (!this.redisProducer) throw new Error('RedisStreamsActor: producer not connected');
    const p = env.payload;
    const args: string[] = [p.stream];
    if (p.maxLenApprox !== undefined) {
      args.push('MAXLEN', '~', String(p.maxLenApprox));
    }
    args.push('*');  // auto-id
    for (const [k, v] of Object.entries(p.fields)) { args.push(k, v); }
    await this.redisProducer.xadd(...args);
  }

  override onReceive(cmd: RedisStreamsCmd): void {
    if (cmd.kind === 'publish') {
      this.enqueueOutbound(cmd.publish);
    } else if (cmd.kind === 'ack') {
      if (this.redis && this.settings.consumerGroup) {
        void this.redis.xack(cmd.stream, this.settings.consumerGroup.group, cmd.id)
          .catch((e: Error) => this.log.warn(`xack failed: ${e.message}`));
      }
    }
  }

  /* ----------------------------- internals ----------------------------- */

  private async consumerLoop(): Promise<void> {
    const cg = this.settings.consumerGroup!;
    const blockMs = this.settings.blockMs ?? 5_000;
    while (this.consumerLoopRunning && this.redis) {
      try {
        const args: string[] = ['GROUP', cg.group, cg.consumer,
          'BLOCK', String(blockMs), 'COUNT', '32',
          'STREAMS', ...(this.settings.streams ?? []),
          ...(this.settings.streams ?? []).map(() => '>'),
        ];
        const result = await this.redis.xreadgroup(...args) as XReadResult | null;
        if (!result) continue;
        for (const [stream, entries] of result) {
          for (const [id, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i + 1 < fields.length; i += 2) {
              obj[fields[i]!] = fields[i + 1]!;
            }
            this.settings.target?.tell({ stream, id, fields: obj });
          }
        }
      } catch (e) {
        if (!this.consumerLoopRunning) return;
        this.log.warn(`RedisStreams consumer loop error: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}

/* ----------------------------- internals -------------------------------- */

type XReadResult = Array<[string, Array<[string, string[]]>]>;

interface IoredisClientLike {
  xadd(...args: string[]): Promise<string>;
  xack(stream: string, group: string, id: string): Promise<number>;
  xgroup(...args: string[]): Promise<unknown>;
  xreadgroup(...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface IoredisCtor {
  new (url: string): IoredisClientLike;
}

interface IoredisModule { default?: IoredisCtor; }

const ioredisLazy: Lazy<Promise<IoredisModule>> = Lazy.of(
  () => lazyImportModule<IoredisModule>('ioredis', { context: 'RedisStreamsActor' }),
);
