import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import { HonoBackendOptions } from '../../../../src/http/backend/HonoBackendOptions.js';
import { detectRuntime } from '../../../../src/runtime/Detect.js';
import { runHttpBackendSuite } from './HttpBackendSuite.js';

/** `Bun.serve` hands back no `node:http` server, so the bounds actor-ts installs on one have nowhere to go. */
const underBun = detectRuntime() === 'bun';
const bunServe = (what: string): { reason: string } => ({
  reason: `Bun.serve has no ${what} and hands back no node:http server to install one on; the binding reports it not in effect and bind() warns.`,
});

runHttpBackendSuite({
  label: 'hono',
  makeBackend: () => new HonoBackend(),
  makeBackendWithBodyCap: (bytes) => new HonoBackend(HonoBackendOptions.create().withMaxBodyBytes(bytes)),
  deviations: underBun
    ? {
      streamedBodyIsChunked: { reason: 'Bun.serve drops a handler-set content-length on a stream body and re-frames it as chunked.' },
      idleTimeoutOnFourSecondSweep: { reason: 'Bun.serve counts idleTimeout in whole seconds and checks it on a 4 s sweep.' },
      noHeaderDeadline: bunServe('header deadline'),
      noRequestTimeout: bunServe('request timeout'),
      noConnectionCap: bunServe('connection cap'),
    }
    : {},
});
