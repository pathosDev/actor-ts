import { HonoBackend } from '../../../../../src/http/backend/HonoBackend.js';
import { runWebsocketBackendSuite } from './WebsocketBackendSuite.js';

runWebsocketBackendSuite('hono', () => new HonoBackend());
