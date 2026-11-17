import { FastifyBackend, fastifyFactoryOptions } from '../../../../src/http/backend/FastifyBackend.js';
import { runHttpBackendSuite } from './HttpBackendSuite.js';

runHttpBackendSuite({
  label: 'fastify',
  makeBackend: () => new FastifyBackend({ logger: false }),
  // Fastify's native `bodyLimit` — it has no options family of its own yet (#667).
  makeBackendWithBodyCap: (bytes) => new FastifyBackend({ logger: false, bodyLimit: bytes }),
  // Fastify takes its body and header caps at construction, and refuses a
  // server option that disagrees with them at `listen()` (#1488).
  makeBackendFor: (serverOptions) => new FastifyBackend({ logger: false, ...fastifyFactoryOptions(serverOptions) }),
});
