/**
 * REST comparison — same route tree (plain GET, JSON GET, path-param
 * lookup, JSON POST) served through Fastify, Express, and Hono in
 * sequence.  The harness prints one row per backend/route so the three
 * stacks can be compared directly on the same hardware and same DSL.
 *
 *   bun run benchmarks/http/rest-comparison.ts
 */
import {
  ActorSystem,
  ActorSystemOptions,
  ExpressBackend,
  FastifyBackend,
  HonoBackend,
  HttpExtensionId,
  LogLevel,
  NoopLogger,
  Status,
  complete,
  completeJson,
  concat,
  entity,
  get,
  path,
  post,
  type HttpServerBackend,
  type ServerBinding,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

const ITERATIONS = 2_000;

type UsersDb = Map<string, { id: string; name: string }>;

function makeRoutes(users: UsersDb): Parameters<Awaited<ReturnType<typeof startServer>>['rebind']>[0] {
  return concat(
    path('ok',   get(() => complete(Status.OK, 'ok'))),
    path('json', get(() => completeJson(Status.OK, { ok: true }))),
    path('users', concat(
      post(async (req) => {
        const body = entity<{ id: string; name: string }>(req);
        users.set(body.id, { id: body.id, name: body.name });
        return completeJson(Status.Created, users.get(body.id));
      }),
      path(':id', get((req) => {
        const u = users.get(req.params.id);
        return u ? completeJson(Status.OK, u) : complete(Status.NotFound, 'missing');
      })),
    )),
  );
}

interface Harness {
  base: string;
  binding: ServerBinding;
  system: ActorSystem;
  rebind(routes: ReturnType<typeof makeRoutes>): Promise<void>;
}

async function startServer(
  label: string,
  backendFactory: () => HttpServerBackend,
): Promise<Harness> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(`bench-rest-${label}`, systemOptions);
  const http = system.extension(HttpExtensionId);
  return {
    base: '',
    binding: null as unknown as ServerBinding,
    system,
    async rebind(routes) {
      const backend = backendFactory();
      const binding = await http.newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
      (this as Harness).base = `http://${binding.host}:${binding.port}`;
      (this as Harness).binding = binding;
    },
  };
}

async function runBackend(
  label: string,
  backendFactory: () => HttpServerBackend,
): Promise<void> {
  const users: UsersDb = new Map();
  const h = await startServer(label, backendFactory);
  await h.rebind(makeRoutes(users));

  // Seed a user so the /users/:id GET always hits an existing entity.
  await fetch(`${h.base}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'alice', name: 'Alice' }),
  });

  await runGroup(`http · ${label} backend (REST)`, [
    {
      name: 'GET /ok        (plain)',
      unit: 'req', iterations: ITERATIONS,
      run: async () => { await (await fetch(`${h.base}/ok`)).text(); },
    },
    {
      name: 'GET /json      (JSON)',
      unit: 'req', iterations: ITERATIONS,
      run: async () => { await (await fetch(`${h.base}/json`)).json(); },
    },
    {
      name: 'GET /users/:id (path param)',
      unit: 'req', iterations: ITERATIONS,
      run: async () => { await (await fetch(`${h.base}/users/alice`)).json(); },
    },
    {
      name: 'POST /users    (JSON body)',
      unit: 'req', iterations: ITERATIONS / 2,
      run: async () => {
        await (await fetch(`${h.base}/users`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'bob', name: 'Bob' }),
        })).json();
      },
    },
  ]);

  await h.binding.unbind();
  await h.system.terminate();
}

async function main(): Promise<void> {
  console.log(
    '\n  REST backend comparison — same routes, same DSL, three HTTP stacks\n'
    + '  (iterations per row: ' + ITERATIONS.toLocaleString('en-US') + ', POST runs at half count)\n',
  );

  await runBackend('Fastify', () => new FastifyBackend({ logger: false }));
  await runBackend('Express', () => new ExpressBackend());
  await runBackend('Hono',    () => new HonoBackend());
}

void main();
