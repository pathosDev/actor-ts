/**
 * HTTP example: serve the routing DSL through Hono.  Same routes as the
 * Fastify / Express examples — only the backend instance handed to
 * `.useBackend(...)` changes.  Hono is a lightweight, Bun-first router; a
 * nice choice when you want modern middleware (CORS, JWT, logger) without
 * pulling Express.
 *
 *   bun add hono           # optional peer dependency
 *   bun run examples/http/hono-backend.ts
 *
 * Then in another terminal:
 *   curl http://127.0.0.1:8080/hello
 *   curl -X POST -H 'content-type: application/json' \
 *        -d '{"name":"bob"}' http://127.0.0.1:8080/users
 *   curl http://127.0.0.1:8080/users/bob
 */
import {
  ActorSystem,
  HonoBackend,
  HonoBackendOptions,
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
  const system = ActorSystem.create('hono-demo');

  const users = new Map<string, User>();

  const routes = concat(
    path('hello', get(() => complete(Status.OK, 'hello from hono'))),
    path('users', concat(
      get(() => completeJson(Status.OK, [...users.values()])),
      post(async (req) => {
        const body = entity<{ name: string }>(req);
        const id = body.name.toLowerCase();
        users.set(id, { id, name: body.name });
        return completeJson(Status.Created, users.get(id));
      }),
      path(':id', get((req) => {
        const u = users.get(req.params.id);
        return u ? completeJson(Status.OK, u) : complete(Status.NotFound, 'unknown user');
      })),
    )),
  );

  const backendOptions = HonoBackendOptions.create()
    .withMaxBodyBytes(1 * 1024 * 1024);
  const backend = new HonoBackend(backendOptions);
  // Optional: reach through to the raw Hono app to attach native middleware.
  //   const app = backend.getApp();
  //   app.use('/*', cors());

  const binding = await system.http(8080, { host: '127.0.0.1', backend }).bind(routes);

  console.log(`Hono server listening on http://${binding.host}:${binding.port}`);

  process.on('SIGINT', async () => {
    console.log('\nshutting down');
    await binding.unbind(1_000);
    await system.terminate();
    process.exit(0);
  });
}

void main();
