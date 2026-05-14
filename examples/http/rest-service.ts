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
  ClusterSharding,
  HttpError,
  Props,
  Status,
  ask,
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

async function main(): Promise<void> {
  const system = ActorSystem.create('rest-service');
  const cluster = await Cluster.join(system, { host: '127.0.0.1', port: 2552 });
  const sharding = ClusterSharding.get(system, cluster);
  const region = sharding.start<UserCmd>({
    typeName: 'user',
    entityProps: Props.create(() => new UserEntity()),
    extractEntityId: msg => ('id' in msg ? msg.id : msg.user.id),
    numShards: 16,
  });

  const askUser = (cmd: UserCmd): Promise<UserReply> => ask<UserCmd, UserReply>(region, cmd, 500);

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
