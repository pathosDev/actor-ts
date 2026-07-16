/**
 * REST service backed by ClusterSharding.  Each /users/:id call reads or
 * writes the corresponding sharded entity actor through the region ref.
 *
 *   bun run examples/http/rest-service.ts
 *   curl http://localhost:8080/users/alice
 *   curl -X POST http://localhost:8080/users \
 *        -H 'content-type: application/json' \
 *        -d '{"id":"alice","name":"Alice","email":"alice@example.com"}'
 */
import { match } from 'ts-pattern';
import {
  Actor,
  ActorSystem,
  Cluster,
  ClusterOptions,
  HttpError,
  Props,
  StartShardingOptions,
  Status,
  complete,
  completeJson,
  concat,
  del,
  entity,
  get,
  path,
  post,
  put,
} from '../../src/index.js';

interface User { readonly id: string; readonly name: string; readonly email: string; }

type UserCommand =
  | { kind: 'set'; user: User }
  | { kind: 'get'; id: string }
  | { kind: 'delete'; id: string };

type UserReply = User | null | { deleted: true };

class UserEntity extends Actor<UserCommand> {
  private user: User | null = null;
  override onReceive(cmd: UserCommand): void {
    match(cmd)
      .with({ kind: 'set' }, (c) => this.onSet(c))
      .with({ kind: 'get' }, () => this.onGet())
      .with({ kind: 'delete' }, () => this.onDelete())
      .exhaustive();
  }

  private reply(msg: UserReply): void {
    this.sender.forEach((s) => s.tell(msg));
  }

  private onSet(c: Extract<UserCommand, { kind: 'set' }>): void {
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

async function main(): Promise<void> {
  const system = ActorSystem.create('rest-service');
  const clusterOptions = ClusterOptions.create()
    .withHost('127.0.0.1')
    .withPort(2552);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<UserCommand>()
    .withExtractEntityId((msg) => ('id' in msg ? msg.id : msg.user.id))
    .withNumShards(16);
  const region = cluster.sharding.start('user', UserEntity, shardingOptions);

  const askUser = (cmd: UserCommand): Promise<UserReply> => region.ask<UserReply>(cmd, 500);

  const routes = path('users', concat(
    path(':id', concat(
      get(async req => {
        const user = await askUser({ kind: 'get', id: req.params.id! });
        if (!user) throw new HttpError(Status.NotFound, `user ${req.params.id} not found`);
        return completeJson(Status.OK, user);
      }),
      del(async req => {
        await askUser({ kind: 'delete', id: req.params.id! });
        return complete(Status.NoContent);
      }),
      put(async req => {
        const body = entity<Omit<User, 'id'>>(req);
        const saved = await askUser({
          kind: 'set',
          user: { id: req.params.id!, ...body },
        });
        return completeJson(Status.OK, saved as User);
      }),
    )),
    post(async req => {
      const user = entity<User>(req);
      const saved = await askUser({ kind: 'set', user });
      return completeJson(Status.Created, saved as User);
    }),
  ));

  const binding = await system.http(8080, { host: '127.0.0.1' }).bind(routes);
  system.log.info(`REST service listening on http://${binding.host}:${binding.port}`);

  process.on('SIGINT', async () => {
    await binding.unbind();
    await cluster.leave();
    await system.terminate();
    process.exit(0);
  });
}

void main();
