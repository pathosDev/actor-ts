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

async function main(): Promise<void> {
  const system = ActorSystem.create('rest-service');
  const clusterOptions = ClusterOptions.create()
    .withHost('127.0.0.1')
    .withPort(2552);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<UserCommand>()
    .withExtractEntityId((message) => ('id' in message ? message.id : message.user.id))
    .withNumShards(16);
  const region = cluster.sharding.start('user', UserEntity, shardingOptions);

  const askUser = (command: UserCommand): Promise<UserReply> => region.ask<UserReply>(command, 500);

  const routes = path('users', concat(
    path(':id', concat(
      get(async request => {
        const user = await askUser({ kind: 'get', id: request.params.id! });
        if (!user) throw new HttpError(Status.NotFound, `user ${request.params.id} not found`);
        return completeJson(Status.OK, user);
      }),
      del(async request => {
        await askUser({ kind: 'delete', id: request.params.id! });
        return complete(Status.NoContent);
      }),
      put(async request => {
        const body = entity<Omit<User, 'id'>>(request);
        const saved = await askUser({
          kind: 'set',
          user: { id: request.params.id!, ...body },
        });
        return completeJson(Status.OK, saved as User);
      }),
    )),
    post(async request => {
      const user = entity<User>(request);
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
