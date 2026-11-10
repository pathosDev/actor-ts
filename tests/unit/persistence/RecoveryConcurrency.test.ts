import { describe, expect, test } from 'bun:test';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { RecoveryPermits } from '../../../src/persistence/RecoveryPermits.js';
import { createTestActorSystem } from '../../util/TestActorSystem.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #874 — `actor-ts.persistence.max-concurrent-recoveries`.
 *
 * A shard hand-off re-creates every entity a region owns at once and each one
 * replays, so without a cap a rolling restart opens thousands of concurrent
 * reads against a pool sized for tens.  The assertions below are on
 * `peakInFlight` rather than on a sampled `inFlight`, deliberately: a test
 * that looked at the counter would only ever see it at the moments it
 * happened to look, and would pass against a cap that never held.
 */

/** A promise plus its resolver — the shape a controlled interleaving needs. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('RecoveryPermits', () => {
  test('never lets more than the cap run at once', async () => {
    const permits = new RecoveryPermits(2);
    const gates = Array.from({ length: 5 }, () => deferred());
    const runs = gates.map((gate) => permits.run(() => gate.promise));

    await awaitCondition(() => permits.inFlight === 2, { label: 'the first two recoveries started' });
    expect(permits.queued).toBe(3);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);

    expect(permits.peakInFlight).toBe(2);
    expect(permits.inFlight).toBe(0);
    expect(permits.queued).toBe(0);
  });

  test('a failing recovery still releases its permit', async () => {
    // The common case this cap exists for: a journal outage fails every
    // replay it is holding back.  A permit leaked per failure would wedge the
    // system permanently at exactly the moment the journal comes back.
    const permits = new RecoveryPermits(1);

    await expect(permits.run(async () => { throw new Error('journal is gone'); }))
      .rejects.toThrow('journal is gone');

    expect(permits.inFlight).toBe(0);
    await expect(permits.run(async () => 'the next one runs')).resolves.toBe('the next one runs');
  });

  test('hands a released permit to the head of the queue rather than the newest caller', async () => {
    // FIFO, because the alternative starves: under a restart storm a LIFO
    // queue lets the entities that asked last go first, and the ones that
    // asked first sit behind them until the storm ends — which is the window
    // `recovery-timeout` is measuring.
    const permits = new RecoveryPermits(1);
    const order: string[] = [];
    const first = deferred();

    const held = permits.run(async () => { order.push('held'); await first.promise; });
    await awaitCondition(() => permits.inFlight === 1, { label: 'the first permit was taken' });
    const second = permits.run(async () => { order.push('second'); });
    const third = permits.run(async () => { order.push('third'); });

    first.resolve();
    await Promise.all([held, second, third]);

    expect(order).toEqual(['held', 'second', 'third']);
    expect(permits.peakInFlight).toBe(1);
  });

  test('refuses a cap it cannot honour', () => {
    // `0` is the documented "uncapped", and the extension answers it by not
    // building one of these at all — so reaching the constructor with 0 is a
    // wiring bug, not a configuration one.
    expect(() => new RecoveryPermits(0)).toThrow(/integer >= 1/);
    expect(() => new RecoveryPermits(1.5)).toThrow(/integer >= 1/);
  });
});

describe('PersistenceExtension — the recovery gate', () => {
  test('builds the gate from the configured cap', async () => {
    const system = createTestActorSystem({
      name: 'recovery-cap',
      config: { 'actor-ts': { persistence: { 'max-concurrent-recoveries': 3 } } },
    });
    const extension = system.extension(PersistenceExtensionId);
    const gates = Array.from({ length: 4 }, () => deferred());

    const runs = gates.map((gate) => extension.withRecoveryPermit(() => gate.promise));
    await awaitCondition(() => extension.recoveryPermits?.inFlight === 3, {
      label: 'three recoveries in flight under a cap of three',
    });

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);

    expect(extension.recoveryPermits?.peakInFlight).toBe(3);
    await system.terminate();
  });

  test('0 is uncapped — there is no gate and no queue', async () => {
    const system = createTestActorSystem({
      name: 'recovery-uncapped',
      config: { 'actor-ts': { persistence: { 'max-concurrent-recoveries': 0 } } },
    });
    const extension = system.extension(PersistenceExtensionId);
    const gates = Array.from({ length: 6 }, () => deferred());
    let started = 0;

    const runs = gates.map((gate) => extension.withRecoveryPermit(async () => {
      started++;
      await gate.promise;
    }));
    await awaitCondition(() => started === 6, { label: 'every recovery started immediately' });

    expect(extension.recoveryPermits).toBeNull();
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    await system.terminate();
  });
});
