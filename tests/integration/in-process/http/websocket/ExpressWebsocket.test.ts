import { ExpressBackend } from '../../../../../src/http/backend/ExpressBackend.js';
import { runWebsocketBackendSuite } from './websocketBackendSuite.js';

runWebsocketBackendSuite('express', () => new ExpressBackend());
