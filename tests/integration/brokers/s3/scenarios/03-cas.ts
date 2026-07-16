/**
 * CAS — `ifMatch` and `ifNoneMatch:*`.  The unit tests verify
 * we translate the SDK error correctly; this scenario verifies
 * the SERVER actually rejects on the expected condition.  MinIO
 * has supported `If-None-Match: *` PUT since the 2024-08
 * S3-spec update; older MinIO releases would return 501.  We
 * track `minio/minio:latest`, which is well past that — if a
 * future MinIO release ever regresses, this scenario is exactly
 * where it should show up.
 */
import { ObjectStorageConcurrencyError } from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';
import { backend, type S3Context } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<S3Context> = {
  name: 'CAS — ifMatch + ifNoneMatch live precondition',
  async run(ctx) {
    const store = backend(ctx);
    try {
      const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const exists = `b2/cas-exists-${tag}.bin`;
      const moved = `b2/cas-moved-${tag}.bin`;

      // ifNoneMatch:* — first write succeeds, second fails.
      await store.put(exists, new Uint8Array([0]));
      let caught: unknown = null;
      try {
        await store.put(exists, new Uint8Array([1]), { ifNoneMatch: '*' });
      } catch (e) { caught = e; }
      if (!(caught instanceof ObjectStorageConcurrencyError)) {
        throw new Error(`expected ObjectStorageConcurrencyError, got ${caught}`);
      }

      // ifMatch — stale etag is rejected after another write moves the object.
      const { etag: stale } = await store.put(moved, new Uint8Array([0]));
      await store.put(moved, new Uint8Array([1])); // someone else writes
      caught = null;
      try {
        await store.put(moved, new Uint8Array([2]), { ifMatch: stale });
      } catch (e) { caught = e; }
      if (!(caught instanceof ObjectStorageConcurrencyError)) {
        throw new Error(`expected ObjectStorageConcurrencyError on stale ifMatch, got ${caught}`);
      }
    } finally {
      await store.close();
    }
  },
};
