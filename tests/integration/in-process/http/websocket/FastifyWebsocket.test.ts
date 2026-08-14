import { FastifyBackend } from '../../../../../src/http/backend/FastifyBackend.js';
import { runWebsocketBackendSuite } from './WebsocketBackendSuite.js';

runWebsocketBackendSuite('fastify', () => new FastifyBackend({ logger: false }));
