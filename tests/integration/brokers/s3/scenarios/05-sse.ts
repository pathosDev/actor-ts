/**
 * Server-side encryption — verify MinIO accepts the SSE-AES256
 * header our adapter emits.  KMS (`aws:kms`) testing requires
 * MinIO Enterprise's KMS endpoint, which isn't available in the
 * open-source server; that path is exercised against AWS proper in
 * separate manual smoke tests.  Here we pin the AES256 path
 * end-to-end against the most common SSE mode.
 */
import { backend, type S3Ctx } from '../runner.js';
import type { BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<S3Ctx> = {
  name: 'SSE — AES256 round-trip',
  async run(ctx) {
    const b = backend(ctx);
    try {
      const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const key = `b2/sse-aes256-${tag}.bin`;
      const body = new Uint8Array([42, 13, 7, 1]);

      // PUT with SSE — adapter sets ServerSideEncryption=AES256.
      await b.put(key, body, { sse: 'AES256' });

      // GET round-trips the bytes — MinIO decrypts transparently on
      // read, no client-side change required.
      const got = await b.get(key);
      if (got.isNone()) throw new Error('GET after SSE PUT returned None');
      const bytes = Array.from(got.toNullable()!.body);
      if (bytes.join(',') !== Array.from(body).join(',')) {
        throw new Error(`SSE round-trip mismatch: got ${bytes.join(',')}`);
      }
    } finally {
      await b.close();
    }
  },
};
