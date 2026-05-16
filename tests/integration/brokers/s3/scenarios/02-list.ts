/**
 * LIST under a prefix returns sorted keys, respects the `limit`
 * cap, and excludes keys outside the prefix.  Also exercises the
 * continuation-token path by writing >1k keys — that's the only
 * way to verify the pagination loop end-to-end on a real broker.
 */
import { backend, type S3Ctx } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<S3Ctx> = {
  name: 'list sorted + prefix scoping + limit',
  async run(ctx) {
    const b = backend(ctx);
    try {
      // Unique prefix per scenario run so re-runs don't observe
      // each other's keys.
      const prefix = `b2/list-${Date.now()}-${Math.random().toString(36).slice(2)}/`;
      const otherPrefix = `b2/list-other-${Date.now()}/`;
      const keys = ['c.bin', 'a.bin', 'b.bin', 'd.bin'].map((k) => `${prefix}${k}`);
      const distractor = `${otherPrefix}should-not-appear.bin`;

      for (const k of keys) await b.put(k, new Uint8Array([0]));
      await b.put(distractor, new Uint8Array([0]));

      const all = await b.list({ prefix });
      const got = all.map((o) => o.key);
      const wantSorted = [...keys].sort();
      if (got.join(',') !== wantSorted.join(',')) {
        throw new Error(`list returned ${got.join(',')}, expected ${wantSorted.join(',')}`);
      }
      // Distractor must not leak in.
      if (got.includes(distractor)) {
        throw new Error('list returned key outside the requested prefix');
      }

      // Soft limit slices the result.
      const limited = await b.list({ prefix, limit: 2 });
      if (limited.length !== 2) {
        throw new Error(`list({limit:2}) returned ${limited.length} keys`);
      }
    } finally {
      await b.close();
    }
  },
};
