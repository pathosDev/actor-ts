import { describe, expect, test } from 'bun:test';
import { Config } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';

/**
 * #1464 decided that the `securityHeaders` bundle and CSP stay code-only: no
 * block, no keys, and no config hook on either middleware.  The reasons are on
 * the two option files and the two pages — the three states of
 * `withSecurityHeaders(...)` a block would have to layer under, and a
 * configuration file that could widen a CSP for every route — and they are
 * also why the decision is pinned here rather than left to a page: a block
 * added later should arrive as a change to this file, made on purpose, and not
 * as one more config group nobody weighed against that tri-state.
 *
 * What this does not see: a block under a name these patterns do not match.
 */
describe('securityHeaders() and contentSecurityPolicy() stay code-only (#1464)', () => {
  test('reference.conf publishes no block for either', () => {
    const reference = Config.loadReference();
    const published = ['actor-ts.http.security-headers', 'actor-ts.http.csp', 'actor-ts.http.content-security-policy']
      .filter((block) => reference.hasPath(block));
    expect(published).toEqual([]);
  });

  test('ConfigKeys declares no group for either', () => {
    const groups = Object.keys(ConfigKeys.http).filter((group) => /security|csp/i.test(group));
    expect(groups).toEqual([]);
  });
});
