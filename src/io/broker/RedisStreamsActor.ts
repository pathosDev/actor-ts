import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { RedisStreamsOptions, RedisStreamsOptionsType } from './RedisStreamsOptions.js';

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

export type RedisStreamsCommand =
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
  extends BrokerActor<RedisStreamsOptionsType, RedisStreamsCommand, RedisStreamPublish> {
  private redis: IoredisClientLike | null = null;
  private redisProducer: IoredisClientLike | null = null;
  private consumerLoopRunning = false;

  constructor(options: RedisStreamsOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.redisStreams; }
  protected builtInDefaultOptions(): Partial<RedisStreamsOptionsType> {
    return { blockMs: 5_000 };
  }
  protected readOptionsFromConfig(c: Config): Partial<RedisStreamsOptionsType> {
    const out: { -readonly [K in keyof RedisStreamsOptionsType]?: RedisStreamsOptionsType[K] } = {};
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
  protected requiredOptions(): ReadonlyArray<keyof RedisStreamsOptionsType> { return ['url']; }
  protected endpointLabel(): string { return this.options.url ?? '<unknown>'; }

  protected async connectImplementation(): Promise<void> {
    const ioredis = await ioredisLazy.get();
    const Constructor = ioredis.default ?? (ioredis as unknown as IoredisConstructor);
    this.redisProducer = new Constructor(this.options.url!);
    if (this.options.consumerGroup && this.options.streams && this.options.target) {
      this.redis = new Constructor(this.options.url!);
      const cg = this.options.consumerGroup;
      if (cg.createIfMissing ?? true) {
        for (const stream of this.options.streams) {
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

  protected async disconnectImplementation(): Promise<void> {
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

  override onReceive(cmd: RedisStreamsCommand): void {
    if (cmd.kind === 'publish') {
      this.enqueueOutbound(cmd.publish);
    } else if (cmd.kind === 'ack') {
      if (this.redis && this.options.consumerGroup) {
        void this.redis.xack(cmd.stream, this.options.consumerGroup.group, cmd.id)
          .catch((e: Error) => this.log.warn(`xack failed: ${e.message}`));
      }
    }
  }

  /* ----------------------------- internals ----------------------------- */

  private async consumerLoop(): Promise<void> {
    const cg = this.options.consumerGroup!;
    const blockMs = this.options.blockMs ?? 5_000;
    while (this.consumerLoopRunning && this.redis) {
      try {
        const args: string[] = ['GROUP', cg.group, cg.consumer,
          'BLOCK', String(blockMs), 'COUNT', '32',
          'STREAMS', ...(this.options.streams ?? []),
          ...(this.options.streams ?? []).map(() => '>'),
        ];
        const result = await this.redis.xreadgroup(...args) as XReadResult | null;
        if (!result) continue;
        for (const [stream, entries] of result) {
          for (const [id, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i + 1 < fields.length; i += 2) {
              obj[fields[i]!] = fields[i + 1]!;
            }
            this.options.target?.tell({ stream, id, fields: obj });
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

interface IoredisConstructor {
  new (url: string): IoredisClientLike;
}

interface IoredisModule { default?: IoredisConstructor; }

const ioredisLazy: Lazy<Promise<IoredisModule>> = Lazy.of(
  () => lazyImportModule<IoredisModule>('ioredis', { context: 'RedisStreamsActor' }),
);
