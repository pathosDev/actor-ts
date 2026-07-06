/**
 * Payload-size sensitivity — how does the ask round-trip cost scale with
 * the size of the message body?  Same echo actor, same ask pattern, only
 * the byte count of the payload changes.
 *
 * Useful for sizing decisions: should a given message be a pointer-style
 * reference (tiny) or carry its whole body?  The per-op cost here is a
 * lower bound on what you pay for "ship the data to the actor".
 *
 *   bun run benchmarks/single-node/payload-size.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props, ask } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

class Echo extends Actor<Uint8Array> {
  override onReceive(m: Uint8Array): void {
    // Reply with the payload's length — avoids re-serialising the whole
    // body on the return leg, keeping the measurement about send-side cost.
    this.sender.forEach((s) => s.tell(m.byteLength));
  }
}

const SIZES = [
  { name: '64 B',   bytes: 64 },
  { name: '1 KB',   bytes: 1_024 },
  { name: '16 KB',  bytes: 16 * 1_024 },
  { name: '64 KB',  bytes: 64 * 1_024 },
  { name: '256 KB', bytes: 256 * 1_024 },
] as const;

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-payload', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const ref = system.spawnAnonymous(Props.create(() => new Echo()));

  console.log('\n  Payload-size sensitivity — ask round-trip for increasing body sizes\n');

  for (const { name, bytes } of SIZES) {
    const payload = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) payload[i] = i & 0xff;
    // Scale iterations so large payloads don't dominate total runtime but
    // stay big enough to get a stable median.
    const iterations = bytes <= 1_024 ? 5_000 : bytes <= 16_384 ? 2_000 : 500;

    await runGroup(`single-node · ask payload=${name}`, [
      {
        name: `ask round-trip (${name})`,
        unit: 'ask',
        iterations,
        run: async () => { await ask<Uint8Array, number>(ref, payload, 5_000); },
      },
    ]);
  }

  await system.terminate();
}

void main();
