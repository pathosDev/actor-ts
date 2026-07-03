import { HonoBackend } from '../../../../../src/http/backend/HonoBackend.js';
import { runWsBackendSuite } from './wsBackendSuite.js';

runWsBackendSuite('hono', () => new HonoBackend());
