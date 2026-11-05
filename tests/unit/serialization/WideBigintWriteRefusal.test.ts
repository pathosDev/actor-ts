import { describe, expect, test } from 'bun:test';
import { encodeFrame, type EnvelopeMessage } from '../../../src/cluster/Protocol.js';
import { JournalError } from '../../../src/persistence/JournalTypes.js';
import { SqliteJournal } from '../../../src/persistence/journals/SqliteJournal.js';
import { encodePayload } from '../../../src/persistence/storage/PayloadCodec.js';
import { CborEncodeError } from '../../../src/serialization/CborCodec.js';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';

/**
 * Where a bigint the codecs will not read back is refused (#967).
 *
 * Both decoders refuse an integer outside `-2^8192 … 2^8192 - 1`.  While the
 * encoders still wrote one, it went out anyway: a journal append that
 * succeeded and a recovery that failed on that row every time after, or a
 * cluster frame the receiving peer answered by closing the connection and
 * losing every frame batched with it.  The encoders refuse it now, and these
 * pin the seams the refusal surfaces at.  What each layer does with it past
 * that is its existing contract, pinned where it lives: `Transport.writeFrame`
 * drops and logs a frame `encodeFrame` refuses
 * (`tests/unit/cluster/WireTypeFidelity.test.ts`), and `persist()` rejects
 * with whatever the journal's append rejects with.
 */
const wide = 1n << 8192n;

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('a bigint no decoder reads back is refused where it would be written', () => {
  test('the persistence payload codec refuses it, through the JSON tree and through CBOR', () => {
    expect(() => encodePayload({ total: wide })).toThrow(SerializationError);
    expect(() => encodePayload({ total: wide }, new CborSerializer())).toThrow(CborEncodeError);
  });

  // A real store, because it is the one that used to keep the row: the write
  // succeeded and `read` then threw.  The journal wraps what the codec threw
  // in its own error and keeps it as the cause.
  test('a SQLite journal refuses the append instead of storing a row no recovery reads', async () => {
    const journal = new SqliteJournal({ path: ':memory:' });
    try {
      const error = await rejectionOf(journal.append('ledger-1', [{ event: { total: wide } }], 0));
      expect(error).toBeInstanceOf(JournalError);
      expect((error as JournalError).cause).toBeInstanceOf(SerializationError);
      expect((error as Error).message)
        .toBe('SqliteJournal.append failed: bigint outside -2^8192 to 2^8192 - 1 at $.total');
      expect(await journal.highestSeq('ledger-1')).toBe(0);
      expect(await journal.read('ledger-1', 1)).toEqual([]);
    } finally {
      await journal.close();
    }
  });

  test('a cluster frame is refused at the sender rather than by the peer', () => {
    const envelope: EnvelopeMessage = {
      kind: 'envelope', to: '/user/ledger', from: null, body: { total: wide },
    };
    expect(() => encodeFrame(envelope)).toThrow(SerializationError);
  });
});
