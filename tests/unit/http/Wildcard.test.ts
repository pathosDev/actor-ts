import { expect, test } from 'bun:test';
import { compile, complete, get, path } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';

// What every backend does with the pattern — the captured remainder, the empty
// remainder and HEAD — is part of the shared HTTP backend contract suite
// (`tests/integration/in-process/http/HttpBackendSuite.ts`, #990).
test('compile emits a trailing-* pattern for a wildcard route', () => {
  const compiled = compile(path('assets', path('*', get(() => complete(Status.OK, '')))));
  expect(compiled[0]!.kind === 'http' && compiled[0]!.pattern).toBe('/assets/*');
});
