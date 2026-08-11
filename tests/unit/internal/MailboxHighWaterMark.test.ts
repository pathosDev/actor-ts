import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { MAILBOX_HIGH_WATER_MARK } from '../../../src/internal/Constants.js';

/**
 * #1148 removed the default mailbox bound, which makes this warning the
 * framework's only unconditional signal that an actor is losing to its
 * producers.  It has to fire without metrics, without DevTools and without
 * anyone having configured anything — so the test drives it through a real
 * system and reads a real logger, not a spy on the private method.
 */
class RecordingLogger implements Logger {
  readonly warnings: string[] = [];

  constructor(
    public level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  debug(_message: string): void {}
  info(_message: string): void {}
  error(_message: string): void {}
  warn(message: string): void { this.sink.warnings.push(message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/** Warnings this cell emitted about its backlog, ignoring any other noise. */
const backlogWarnings = (logger: RecordingLogger): string[] =>
  logger.warnings.filter((w) => w.startsWith('mailbox depth '));

/**
 * Wedges an actor on a latch, queues `count` messages behind it, and returns
 * the backlog warnings that produced.  The latch is what makes the depth
 * deterministic: message 0 never completes, so nothing drains.
 */
async function queueBehindLatch(
  name: string,
  count: number,
  options?: ActorOptions<number>,
): Promise<{ warnings: string[]; terminate: () => Promise<void> }> {
  const logger = new RecordingLogger();
  const system = ActorSystem.create(
    name,
    ActorSystemOptions.create().withLogger(logger).withLogLevel(LogLevel.Debug),
  );

  let release: () => void = () => {};
  const latch = new Promise<void>((resolve) => { release = resolve; });

  class Sink extends Actor<number> {
    override async onReceive(n: number): Promise<void> { if (n === 0) await latch; }
  }
  const ref = options === undefined
    ? system.spawnAnonymous(Sink)
    : system.spawnAnonymous(Sink, options);
  for (let i = 0; i < count; i++) ref.tell(i);

  const warnings = backlogWarnings(logger);
  release();
  return { warnings, terminate: () => system.terminate() };
}

describe('mailbox high-water mark (#1148)', () => {
  test('a mailbox below the mark says nothing', async () => {
    const { warnings, terminate } = await queueBehindLatch('hwm-quiet', 1_000);
    expect(warnings).toEqual([]);
    await terminate();
  });

  test('crossing the mark warns exactly once, and names the depth', async () => {
    const { warnings, terminate } = await queueBehindLatch(
      'hwm-once',
      MAILBOX_HIGH_WATER_MARK + 1,
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`mailbox depth ${MAILBOX_HIGH_WATER_MARK}`);
    expect(warnings[0]).toContain('withMailboxCapacity');
    await terminate();
  });

  test('a runaway actor escalates rather than repeating — one line per doubling', async () => {
    // 40 001 queued crosses 10 000, 20 000 and 40 000: three lines, not
    // 30 001.  The doubling is what makes the warning safe to leave always-on.
    const { warnings, terminate } = await queueBehindLatch(
      'hwm-doubling',
      MAILBOX_HIGH_WATER_MARK * 4 + 1,
    );
    expect(warnings.length).toBe(3);
    expect(warnings[0]).toContain(`mailbox depth ${MAILBOX_HIGH_WATER_MARK}`);
    expect(warnings[1]).toContain(`mailbox depth ${MAILBOX_HIGH_WATER_MARK * 2}`);
    expect(warnings[2]).toContain(`mailbox depth ${MAILBOX_HIGH_WATER_MARK * 4}`);
    await terminate();
  });

  test('a bounded mailbox under the mark never reaches it — it has its own ceiling', async () => {
    // Not an omission: a capacity of 100 reports its losses through
    // `actor_mailbox_dropped_total`, so a backlog warning would be noise
    // about a queue that is behaving exactly as configured.
    const options = ActorOptions.create<number>().withMailboxCapacity(100);
    const { warnings, terminate } = await queueBehindLatch(
      'hwm-bounded',
      MAILBOX_HIGH_WATER_MARK * 2,
      options,
    );
    expect(warnings).toEqual([]);
    await terminate();
  });
});
