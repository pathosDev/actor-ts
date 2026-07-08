import { HonoBackend } from '../../../../../src/http/backend/HonoBackend.js';
import { runWebsocketBackendSuite } from './websocketBackendSuite.js';

runWebsocketBackendSuite('hono', () => new HonoBackend());
