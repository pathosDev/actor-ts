import { FastifyBackend } from '../../../../../src/http/backend/FastifyBackend.js';
import { runWebsocketBackendSuite } from './websocketBackendSuite.js';

runWebsocketBackendSuite('fastify', () => new FastifyBackend({ logger: false }));
