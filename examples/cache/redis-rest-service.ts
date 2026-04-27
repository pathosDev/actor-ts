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
  ClusterSharding,
  HttpExtensionId,
  HttpError,
  InMemoryCache,
  Props,
  RedisCache,
  Status,
  ask,
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

type UserCmd =
  | { kind: 'set'; user: User }
  | { kind: 'get'; id: string }
  | { kind: 'delete'; id: string };

type UserReply = User | null | { deleted: true };

class UserEntity extends Actor<UserCmd> {
  private user: User | null = null;
  override onReceive(cmd: UserCmd): void {
    const reply = (msg: UserReply): void => this.sender.forEach((s) => s.tell(msg));
    match(cmd)
      .with({ kind: 'set' }, (c) => { this.user = c.user; reply(this.user); })
      .with({ kind: 'get' }, () => reply(this.user))
      .with({ kind: 'delete' }, () => { this.user = null; reply({ deleted: true }); })
      .exhaustive();
  }
}

function pickCache(): Cache {
  if (process.env.ACTOR_TS_CACHE === 'redis') {
    return new RedisCache({ url: process.env.REDIS_URL ?? 'redis://localhost:6379', keyPrefix: 'rest:' });
  }
  return new InMemoryCache();
}

async function main(): Promise<void> {
  const system = ActorSystem.create('rest-cache');
  const cluster = await Cluster.join(system, { host: '127.0.0.1', port: 2552 });
  const sharding = ClusterSharding.get(system, cluster);

  // Wire the cache into the CacheExtension so other parts of the app
  // can grab the same instance via `system.extension(CacheExtensionId).cache()`.
  const cache = pickCache();
  system.extension(CacheExtensionId).setCache('default', cache);

  const region = sharding.start<UserCmd>({
    typeName: 'user',
    entityProps: Props.create(() => new UserEntity()),
    extractEntityId: msg => ('id' in msg ? msg.id : msg.user.id),
    numShards: 16,
  });
  const askUser = (cmd: UserCmd): Promise<UserReply> => ask<UserCmd, UserReply>(region, cmd, 500);

  // Rate limit: 60 req/min per IP — applied to every endpoint below.
  const limit = rateLimit({
    cache, windowMs: 60_000, max: 60,
    key: (req) => req.headers['x-forwarded-for'] ?? '<anon>',
  });

  // Response cache: GET /users/:id is cacheable for 30s.
  const responseCache = cached({
    cache, ttlMs: 30_000,
    key: (req) => `users:${req.params.id}`,
  });

  // Idempotency-key: required on POST /users; 24h replay window.
  const dedup = idempotent({ cache, ttlMs: 24 * 60 * 60_000 });

  const routes = path('users', concat(
    path(':id', concat(
      get(limit(responseCache(async req => {
        const user = await askUser({ kind: 'get', id: req.params.id! });
        if (!user) throw new HttpError(Status.NotFound, `user ${req.params.id} not found`);
        return completeJson(Status.OK, user);
      }))),
      del(limit(async req => {
        await askUser({ kind: 'delete', id: req.params.id! });
        // Invalidate the response cache for this user.
        await cache.delete(`rsp:users:${req.params.id}`);
        return complete(Status.NoContent);
      })),
      put(limit(async req => {
        const body = entity<Omit<User, 'id'>>(req);
        const saved = await askUser({ kind: 'set', user: { id: req.params.id!, ...body } });
        await cache.delete(`rsp:users:${req.params.id}`);
        return completeJson(Status.OK, saved as User);
      })),
    )),
    post(limit(dedup(async req => {
      const user = entity<User>(req);
      const saved = await askUser({ kind: 'set', user });
      return completeJson(Status.Created, saved as User);
    }))),
  ));

  const http = system.extension(HttpExtensionId);
  const binding = await http.newServerAt('127.0.0.1', 8080).bind(routes);
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
