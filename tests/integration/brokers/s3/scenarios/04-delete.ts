/**
 * DELETE is idempotent against a live MinIO bucket.  Deleting a
 * non-existent key must succeed (200/204) — the framework's
 * adapter swallows the "object missing" case via S3's normal
 * idempotency.
 */
import { backend, type S3Ctx } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<S3Ctx> = {
  name: 'delete is idempotent + GET-after-DELETE returns None',
  async run(ctx) {
    const b = backend(ctx);
    try {
      const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const key = `b2/delete-${tag}.bin`;

      // Delete-before-put is a no-op (idempotent on absent).
      await b.delete(key);

      await b.put(key, new Uint8Array([1, 2, 3]));
      const before = await b.get(key);
      if (before.isNone()) throw new Error('GET after PUT returned None');

      await b.delete(key);
      const after = await b.get(key);
      if (after.isSome()) throw new Error('GET after DELETE returned Some — expected None');

      // Second delete must not throw.
      await b.delete(key);
    } finally {
      await b.close();
    }
  },
};
