/**
 * REST service that combines all three HTTP cache primitives — response
 * caching for hot reads, rate limiting for abuse protection, and an
 * idempotency-key middleware for retryable mutations.
 *
 * The example uses an `InMemoryCache` so it runs offline.  To target a
 * real Redis instance:
 *
 *   docker run --rm -p 6379:6379 redis:7-alpine
 *   ACTOR_TS_CACHE=redis bun run examples/cache/redis-rest-service.ts
 *
 *   curl http://localhost:8080/users/alice           # cached for 30s
 *   curl http://localhost:8080/users/alice           # cache hit
 *   curl -X POST http://localhost:8080/users \
 *        -H 'content-type: application/json' \
 *        -H 'idempotency-key: 11111111' \
 *        -d '{"id":"alice","name":"Alice"}'          # first POST
 *   curl -X POST http://localhost:8080/users \
 *        -H 'content-type: application/json' \
 *        -H 'idempotency-key: 11111111' \
 *        -d '{"id":"alice","name":"Should not win"}' # replays first response
 */
import { match } from 'ts-pattern';
import {
  Actor,
  ActorSystem,
  CacheExtensionId,
  Cluster,
  ClusterOptions,
  HttpError,
  InMemoryCache,
  Props,
  RedisCache,
  RedisCacheOptions,
  StartShardingOptions,
  Status,
  cached,
  complete,
  completeJson,
  concat,
  del,
  entity,
  get,
  idempotent,
  path,
  post,
  put,
  rateLimit,
} from '../../src/index.js';
import type { Cache } from '../../src/index.js';

interface User { readonly id: string; readonly name: string; }

type SetCommand = { kind: 'set'; user: User };
type GetCommand = { kind: 'get'; id: string };
type DeleteCommand = { kind: 'delete'; id: string };
type UserCommand = SetCommand | GetCommand | DeleteCommand;

type UserReply = User | null | { deleted: true };

class UserEntity extends Actor<UserCommand> {
  private user: User | null = null;
  override onReceive(command: UserCommand): void {
    match(command)
      .with({ kind: 'set' }, (c) => this.onSet(c))
      .with({ kind: 'get' }, () => this.onGet())
      .with({ kind: 'delete' }, () => this.onDelete())
      .exhaustive();
  }

  private reply(message: UserReply): void {
    this.sender.forEach((s) => s.tell(message));
  }

  private onSet(c: SetCommand): void {
    this.user = c.user;
    this.reply(this.user);
  }

  private onGet(): void {
    this.reply(this.user);
  }

  private onDelete(): void {
    this.user = null;
    this.reply({ deleted: true });
  }
}

function pickCache(): Cache {
  if (process.env.ACTOR_TS_CACHE === 'redis') {
    const cacheOptions = RedisCacheOptions.create()
      .withUrl(process.env.REDIS_URL ?? 'redis://localhost:6379')
      .withKeyPrefix('rest:');
    return new RedisCache(cacheOptions);
  }
  return new InMemoryCache();
}

async function main(): Promise<void> {
  const system = ActorSystem.create('rest-cache');
  const clusterOptions = ClusterOptions.create()
    .withHost('127.0.0.1')
    .withPort(2552);
  const cluster = await Cluster.join(system, clusterOptions);
  // Wire the cache into the CacheExtension so other parts of the app
  // can grab the same instance via `system.extension(CacheExtensionId).cache()`.
  const cache = pickCache();
  system.extension(CacheExtensionId).setCache('default', cache);

  const shardingOptions = StartShardingOptions.create<UserCommand>()
    .withExtractEntityId((message) => ('id' in message ? message.id : message.user.id))
    .withNumShards(16);
  const region = cluster.sharding.start('user', UserEntity, shardingOptions);
  const askUser = (command: UserCommand): Promise<UserReply> => region.ask<UserReply>(command, 500);

  // Rate limit: 60 req/min per IP — applied to every endpoint below.
  const limit = rateLimit({
    cache, windowMs: 60_000, max: 60,
    key: (request) => request.headers['x-forwarded-for'] ?? '<anon>',
  });

  // Response cache: GET /users/:id is cacheable for 30s.
  const responseCache = cached({
    cache, ttlMs: 30_000,
    key: (request) => `users:${request.params.id}`,
  });

  // Idempotency-key: required on POST /users; 24h replay window.
  const dedup = idempotent({ cache, ttlMs: 24 * 60 * 60_000 });

  const routes = path('users', concat(
    path(':id', concat(
      get(limit(responseCache(async request => {
        const user = await askUser({ kind: 'get', id: request.params.id! });
        if (!user) throw new HttpError(Status.NotFound, `user ${request.params.id} not found`);
        return completeJson(Status.OK, user);
      }))),
      del(limit(async request => {
        await askUser({ kind: 'delete', id: request.params.id! });
        // Invalidate the response cache for this user.
        await cache.delete(`rsp:users:${request.params.id}`);
        return complete(Status.NoContent);
      })),
      put(limit(async request => {
        const body = entity<Omit<User, 'id'>>(request);
        const saved = await askUser({ kind: 'set', user: { id: request.params.id!, ...body } });
        await cache.delete(`rsp:users:${request.params.id}`);
        return completeJson(Status.OK, saved as User);
      })),
    )),
    post(limit(dedup(async request => {
      const user = entity<User>(request);
      const saved = await askUser({ kind: 'set', user });
      return completeJson(Status.Created, saved as User);
    }))),
  ));

  const binding = await system.http(8080, { host: '127.0.0.1' }).bind(routes);
  system.log.info(`REST+cache service listening on http://${binding.host}:${binding.port}`);
  system.log.info(`Cache backend: ${process.env.ACTOR_TS_CACHE === 'redis' ? 'Redis' : 'InMemory'}`);

  process.on('SIGINT', async () => {
    await binding.unbind();
    await cluster.leave();
    await cache.close?.();
    await system.terminate();
    process.exit(0);
  });
}

void main();
