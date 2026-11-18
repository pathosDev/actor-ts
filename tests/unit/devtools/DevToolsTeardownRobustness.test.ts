/**
 * A failed DevTools teardown or setup must not lock a system out of the
 * next attach (#714, the remainder its verification left open).
 *
 * The `SpanTap` registry is what turns a skipped release into a permanent
 * lockout: one live tap per system, released only by that tap's own
 * `uninstall()`.  Three paths could skip the release:
 *
 *  - `DevToolsServer.stop()` sets `stopped` and then uninstalls the taps in
 *    order with nothing between them, so a tap before `spans` that throws
 *    skipped the release, and `stopped` refused the retry;
 *  - `DevToolsExtension.mount()` kept the server it built when mounting it
 *    threw, so `isAttached()` reported an attachment that never happened and
 *    every later mount or attach was refused as a duplicate;
 *  - `SpanTap.install()` takes the registry slot first and marks itself
 *    installed only after the tracer swap, so a throw in that window kept
 *    the slot with no tap that would ever give it back.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { parsePathSegments } from '../../../src/ActorPath.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { devtoolsOf } from '../../../src/devtools/DevToolsExtension.js';
import { DevToolsServer, type DevToolsTap } from '../../../src/devtools/DevToolsServer.js';
import type { DevToolsStreamPayload } from '../../../src/devtools/protocol/index.js';
import { SpanTap } from '../../../src/devtools/taps/SpanTap.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/** A tap whose teardown fails — registered first, so it runs before `spans`. */
function throwingTap(): DevToolsTap {
  return {
    stream: 'cluster',
    install(_emit: (payload: DevToolsStreamPayload) => void): void {},
    uninstall(): void {
      throw new Error('tap teardown failed');
    },
    snapshot(): ReadonlyArray<DevToolsStreamPayload> {
      return [];
    },
  };
}

describe('DevToolsServer.stop — one failing tap does not skip the rest (#714)', () => {
  test('the span tap is still released, so the system can be attached again', async () => {
    const system = newSystem('teardown-tap-throws');
    const server = new DevToolsServer(system, { allowUngatedMount: true });
    server.registerTap(throwingTap());
    server.mount();

    await server.stop();

    // Released: a new tap may install, and the switches are back off.
    const tracing = system.extension(TracingExtensionId);
    expect(tracing.isCapturingMessagePayloads()).toBe(false);
    expect(tracing.isRecordingRootSpans()).toBe(false);
    const next = new SpanTap(system, 100, 20);
    expect(() => next.install(() => {})).not.toThrow();
    next.uninstall();
  });
});

/** Whether the hub a server spawns is alive under `/system/devtools`. */
function hubIsAlive(system: ActorSystem): boolean {
  return system._resolvePath(parsePathSegments(`actor-ts://${system.name}/system/devtools/hub`)).isSome();
}

describe('DevToolsExtension.mount — a mount that throws leaves nothing attached (#714)', () => {
  test('isAttached() stays false, the half-started server is torn down, and a later mount succeeds', async () => {
    const system = newSystem('teardown-mount-throws');
    // A tap installed outside DevTools makes the server's own SpanTap refuse,
    // which is a throw from inside `server.mount()`.
    const foreign = new SpanTap(system, 100, 20);
    foreign.install(() => {});
    const extension = devtoolsOf(system);

    expect(() => extension.mount({ allowUngatedMount: true })).toThrow(/already installed/);
    expect(extension.isAttached()).toBe(false);
    // The hub and the taps installed before the refusal go with it.
    await awaitCondition(() => !hubIsAlive(system), { label: 'the half-started hub was stopped' });

    foreign.uninstall();
    expect(() => extension.mount({ allowUngatedMount: true })).not.toThrow();
    expect(extension.isAttached()).toBe(true);
    void extension.detach();
  });
});

describe('SpanTap.install — a throw before it is installed releases its slot (#714)', () => {
  test('the next tap can install once the cause is gone', () => {
    const system = newSystem('teardown-install-throws');
    const tracing = system.extension(TracingExtensionId);
    const realEnable = tracing.enable.bind(tracing);
    tracing.enable = (): never => {
      throw new Error('tracer swap failed');
    };
    try {
      expect(() => new SpanTap(system, 100, 20).install(() => {})).toThrow(/tracer swap failed/);
    } finally {
      tracing.enable = realEnable;
    }

    const next = new SpanTap(system, 100, 20);
    expect(() => next.install(() => {})).not.toThrow();
    next.uninstall();
  });
});
