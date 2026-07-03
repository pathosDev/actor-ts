import { FastifyBackend } from '../../../../../src/http/backend/FastifyBackend.js';
import { runWsBackendSuite } from './wsBackendSuite.js';

runWsBackendSuite('fastify', () => new FastifyBackend({ logger: false }));
