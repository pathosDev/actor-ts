/**
 * HTTP example: swap the default Fastify backend for an Express one.  The
 * routing DSL is identical — only the backend instance passed to
 * `.useBackend(...)` changes.  Handy when you want to reuse an existing
 * Express middleware stack (auth, CORS, Swagger, …).
 *
 *   bun add express   # optional peer dependency
 *   bun run examples/http/express-backend.ts
 *
 * Then in another terminal:
 *   curl http://127.0.0.1:8080/hello
 *   curl -X POST -H 'content-type: application/json' \
 *        -d '{"name":"bob"}' http://127.0.0.1:8080/users
 *   curl http://127.0.0.1:8080/users/bob
 */
import {
  ActorSystem,
  ExpressBackend,
  ExpressBackendOptions,
  Status,
  complete,
  completeJson,
  concat,
  entity,
  get,
  path,
  post,
} from '../../src/index.js';

interface User { readonly id: string; readonly name: string; }

async function main(): Promise<void> {
  const system = ActorSystem.create('express-demo');

  const users = new Map<string, User>();

  const routes = concat(
    path('hello', get(() => complete(Status.OK, 'hello from express'))),
    path('users', concat(
      get(() => completeJson(Status.OK, [...users.values()])),
      post(async (request) => {
        const body = entity<{ name: string }>(request);
        const id = body.name.toLowerCase();
        users.set(id, { id, name: body.name });
        return completeJson(Status.Created, users.get(id));
      }),
      path(':id', get((request) => {
        const user = users.get(request.params.id);
        return user ? completeJson(Status.OK, user) : complete(Status.NotFound, 'unknown user');
      })),
    )),
  );

  const backendOptions = ExpressBackendOptions.create().withMaxBodyBytes(1 * 1024 * 1024);
  const backend = new ExpressBackend(backendOptions);
  // Optional: reach through to the raw Express app to attach native middleware.
  //   const app = backend.getApp();
  //   app.use(cors());

  const binding = await system.http(8080, { host: '127.0.0.1', backend }).bind(routes);

  console.log(`Express server listening on http://${binding.host}:${binding.port}`);

  process.on('SIGINT', async () => {
    console.log('\nshutting down');
    await binding.unbind(1_000);
    await system.terminate();
    process.exit(0);
  });
}

void main();
