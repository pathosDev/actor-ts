import { ExpressBackend } from '../../../../src/http/backend/ExpressBackend.js';
import { ExpressBackendOptions } from '../../../../src/http/backend/ExpressBackendOptions.js';
import { runHttpBackendSuite } from './HttpBackendSuite.js';

runHttpBackendSuite({
  label: 'express',
  makeBackend: () => new ExpressBackend(),
  makeBackendWithBodyCap: (bytes) => new ExpressBackend(ExpressBackendOptions.create().withMaxBodyBytes(bytes)),
});
