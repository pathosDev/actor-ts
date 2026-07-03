import { ExpressBackend } from '../../../../../src/http/backend/ExpressBackend.js';
import { runWsBackendSuite } from './wsBackendSuite.js';

runWsBackendSuite('express', () => new ExpressBackend());
