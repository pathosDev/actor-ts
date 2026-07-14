/**
 * Round-trip: PUT then GET against a live MinIO bucket.  The
 * baseline smoke — if this fails everything downstream is moot.
 */
import { backend, type S3Ctx } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<S3Ctx> = {
  name: 'put-get round-trip',
  async run(ctx) {
    const store = backend(ctx);
    try {
      const key = `b2/put-get-${Date.now()}.bin`;
      const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const { etag } = await store.put(key, body, { contentType: 'application/octet-stream' });
      if (!etag.startsWith('"')) throw new Error(`expected quoted etag, got ${etag}`);

      const got = await store.get(key);
      if (got.isNone()) throw new Error(`GET returned None for key ${key}`);
      const object = got.toNullable()!;
      if (Array.from(object.body).join(',') !== Array.from(body).join(',')) {
        throw new Error(`GET body mismatch: got ${Array.from(object.body).join(',')}`);
      }
      if (object.contentType !== 'application/octet-stream') {
        throw new Error(`GET contentType=${object.contentType}, expected application/octet-stream`);
      }
      if (object.etag !== etag) {
        throw new Error(`GET etag=${object.etag}, expected ${etag}`);
      }
    } finally {
      await store.close();
    }
  },
};
