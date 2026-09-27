/**
 * #1420 — traces without message bodies, at payload granularity.
 *
 * Option C closed the *export* half: the tee withholds
 * `actor.message.payload` from a tracer the application already had,
 * whenever DevTools is what switched capture on.  What it left is the
 * panel's own Payload column, which an attach fills unconditionally, and
 * the only control over it was `panels.tracing: false` — which takes the
 * spans, the timings and the flame graph with it.
 *
 * `capturePayloads` is that missing granularity.  It defaults to `true`,
 * because with the export closed `on` no longer trades an operator's
 * safety for a filled panel, and it is an opt-*out* for the shared
 * staging box whose DevTools port more people can reach than the message
 * bodies should be.
 *
 * ## What each case here discriminates
 *
 * The three that carry the weight, because a plausible wrong fix passes
 * the rest:
 *
 * - **Root spans stay on with the switch off.**  A fix that reads the
 *   switch and skips `recordRootSpans(true)` as well empties the panel —
 *   which is precisely what `panels.tracing: false` already does, and
 *   what this option exists *not* to do.
 * - **A capture the application set for itself survives the attach and
 *   the detach.**  On a quiet system "restored" and "never touched" are
 *   indistinguishable, so only a system that had capture on can tell a
 *   tap that flipped nothing from one that flipped and restored.
 * - **With the switch off the tee withholds nothing.**  The tee exists
 *   to stop *DevTools'* capture reaching a foreign exporter; a tap that
 *   switched nothing on has nothing of its own to withhold, and a
 *   withheld set still computed from `previousMessagePayloads` alone
 *   turns "DevTools declines to add an export" into "DevTools removes
 *   one".  Observable through an application that enables capture
 *   *during* the attach, which is the one door that reaches a tee whose
 *   filter was fixed at install.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Actor } from '../../../src/Actor.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { Config } from '../../../src/config/Config.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { SpanTap } from '../../../src/devtools/taps/SpanTap.js';
import { DevTools } from '../../../src/devtools/DevTools.js';
import {
  DEVTOOLS_DEFAULTS,
  DevToolsOptions,
  mergeDevToolsOptions,
  readDevToolsOptionsFromConfig,
} from '../../../src/devtools/DevToolsOptions.js';
import type { DevToolsStreamPayload, SpanBatchPayload } from '../../../src/devtools/protocol/index.js';

/** The attribute the whole unit is about, spelled once. */
const PAYLOAD_ATTRIBUTE = 'actor.message.payload';

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) {
    await DevTools.detach(system);
    await system.terminate();
  }
});

function newSystem(name: string, logger: Logger = new NoopLogger()): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(logger);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/**
 * Keeps what the system logged, so the attach line can be read back —
 * the shape `SpanTap.test.ts` uses, because the tap warns through
 * `system.log` and every derived logger has to reach one list.
 */
class RecordingLogger implements Logger {
  readonly level = LogLevel.Debug;
  readonly warnings: string[] = [];

  constructor(private readonly root: RecordingLogger | null = null) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  debug(): void {}
  info(): void {}
  warn(message: string): void { this.sink.warnings.push(message); }
  error(): void {}

  withSource(): Logger { return new RecordingLogger(this.sink); }
  withFields(): Logger { return new RecordingLogger(this.sink); }
}

/**
 * Build the tap exactly as `DevToolsServer.start` does, so the fourth
 * argument is exercised in the position the server passes it.
 */
function newTap(system: ActorSystem, capturePayloads: boolean): SpanTap {
  return new SpanTap(
    system,
    DEVTOOLS_DEFAULTS.spanBufferCapacity,
    DEVTOOLS_DEFAULTS.spanFlushIntervalMs,
    capturePayloads,
  );
}

/**
 * Give the tap time to emit whatever the exchange above produced.
 *
 * A fixed delay and not `awaitCondition`, for the reason
 * `SpanTapPayloadWithholding.test.ts` gives: several assertions here are
 * absences, and a predicate over an already-empty array is true at t = 0.
 */
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function spansOf(payloads: ReadonlyArray<DevToolsStreamPayload>) {
  return payloads
    .filter((p): p is SpanBatchPayload => p.kind === 'span-batch')
    .flatMap((p) => p.spans);
}

/**
 * What the panel would be handed on subscribe.
 *
 * The flush ticker is not used for the Payload-column assertions, and
 * deliberately: this harness builds the tap with the *shipped*
 * `spanFlushIntervalMs` of 250 ms, so a fixed settle short enough to keep
 * the file quick would report an empty panel whatever the switch did —
 * a red for the wrong reason, which is exactly what this phase is about.
 * `snapshot()` reads the same ring the ticker drains.
 */
function retainedSpansOf(tap: SpanTap) {
  return spansOf(tap.snapshot());
}

class OrderActor extends Actor<{ kind: string; id: number }> {
  override onReceive(): void {}
}

describe('the capturePayloads option, in the lockstep the options family prescribes', () => {
  test('the built-in default is `true` — the switch is an opt-out', () => {
    expect(DEVTOOLS_DEFAULTS.capturePayloads).toBe(true);
  });

  test('`withCapturePayloads` writes the field, and only that field', () => {
    expect({ ...DevToolsOptions.create().withCapturePayloads(false) })
      .toEqual({ capturePayloads: false });
    expect({ ...DevToolsOptions.create().withCapturePayloads(true) })
      .toEqual({ capturePayloads: true });
  });

  test('a builder that was never asked leaves the field unset', () => {
    // Not `=== undefined`: the merge rule is about the property being
    // *absent*, and a builder that wrote an explicit `undefined` would
    // shadow the config file rather than fall through to it.
    const builder = DevToolsOptions.create().withPort(1);
    expect('capturePayloads' in { ...builder }).toBe(false);
  });

  test('explicit beats the file beats the default, and the default is what fills the gap', () => {
    expect(mergeDevToolsOptions({}, {}).capturePayloads).toBe(true);
    expect(mergeDevToolsOptions({ capturePayloads: false }, {}).capturePayloads).toBe(false);
    expect(mergeDevToolsOptions({ capturePayloads: false }, { capturePayloads: true })
      .capturePayloads).toBe(true);
    // `undefined` on the higher layer means "not set", not "cleared".
    expect(mergeDevToolsOptions({ capturePayloads: false }, { capturePayloads: undefined })
      .capturePayloads).toBe(false);
  });
});

describe('the HOCON leaf reaches the field and nothing else', () => {
  test('`capture-payloads = false` on its own lands on `capturePayloads`', () => {
    // `toStrictEqual`, so a reader that also produced a second field — or
    // the same field as an explicit `undefined` — fails here.
    const config = Config.parseString('actor-ts.devtools { capture-payloads = false }');
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({ capturePayloads: false });
  });

  test('`capture-payloads = true` is read as written, not assumed from the default', () => {
    const config = Config.parseString('actor-ts.devtools { capture-payloads = true }');
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({ capturePayloads: true });
  });

  test('a file naming a neighbouring leaf leaves it absent', () => {
    // The `hasPath` half: an absent leaf must not land as an explicit
    // `undefined`, which would flatten a value the caller set in code.
    const config = Config.parseString('actor-ts.devtools { serve-ui = false }');
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({ serveUi: false });
  });

  test('the leaf and its two boolean neighbours are told apart by value', () => {
    // Three booleans read in a row out of one block: with all three
    // present a swapped `ConfigKeys` read still finds *a* value, so only
    // differing values can separate them.
    const config = Config.parseString(`
      actor-ts.devtools {
        serve-ui = true
        replay-auto-capture = true
        capture-payloads = false
      }
    `);
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({
      serveUi: true,
      replayAutoCapture: true,
      capturePayloads: false,
    });
  });
});

describe('SpanTap honours the switch without touching the rest of the panel', () => {
  test('switched on, the attach flips both switches as it always did', () => {
    const system = newSystem('capture-switch-on');
    const tracing = system.extension(TracingExtensionId);
    const tap = newTap(system, true);
    tap.install(() => {});
    try {
      expect(tracing.isRecordingRootSpans()).toBe(true);
      expect(tracing.isCapturingMessagePayloads()).toBe(true);
    } finally {
      tap.uninstall();
    }
  });

  test('switched off, root spans are still recorded and the capture is not', () => {
    // The assertion that catches the too-broad fix.  Suppressing
    // `recordRootSpans` as well would empty the panel — spans, timings,
    // flame graph — which is what `panels.tracing: false` already does
    // and what this option exists not to do.
    const system = newSystem('capture-switch-off');
    const tracing = system.extension(TracingExtensionId);
    const tap = newTap(system, false);
    tap.install(() => {});
    try {
      expect(tracing.isRecordingRootSpans()).toBe(true);
      expect(tracing.isCapturingMessagePayloads()).toBe(false);
    } finally {
      tap.uninstall();
    }
  });

  test('switched off, the panel still gets its spans and they carry no body', async () => {
    // The acceptance criterion in its own terms: the tracing panel is
    // live and the Payload column is empty.
    const system = newSystem('capture-switch-off-panel');
    const tap = newTap(system, false);
    tap.install(() => {});
    try {
      const ref = system.spawn(OrderActor, 'orders');
      ref.tell({ kind: 'place', id: 7 });
      await settle();

      const row = retainedSpansOf(tap).find((s) => s.actorPath?.endsWith('/orders') === true);
      expect(row).toBeDefined();
      expect(row!.messagePayload).toBeNull();
    } finally {
      tap.uninstall();
    }
  });

  test('switched on, the panel still gets the body — the default is unchanged', async () => {
    const system = newSystem('capture-switch-on-panel');
    const tap = newTap(system, true);
    tap.install(() => {});
    try {
      const ref = system.spawn(OrderActor, 'orders');
      ref.tell({ kind: 'place', id: 7 });
      await settle();

      const row = retainedSpansOf(tap).find((s) => s.actorPath?.endsWith('/orders') === true);
      expect(row).toBeDefined();
      expect(row!.messagePayload).toBe('{"kind":"place","id":7}');
    } finally {
      tap.uninstall();
    }
  });
});

describe('a tap that flipped nothing gives back exactly what it found', () => {
  test('over an application that had capture on: on throughout, and on after detach', () => {
    // The case that discriminates.  On a quiet system "restored" and
    // "never touched" look identical; only a system that had the capture
    // on for itself can tell a tap that flipped and restored from one
    // that left the switch alone — and either way it must read `true`
    // after the detach.
    const system = newSystem('capture-switch-off-over-application-capture');
    const tracing = system.extension(TracingExtensionId);
    tracing.enable(new RecordingTracer());
    tracing.captureMessagePayloads(true);

    const tap = newTap(system, false);
    tap.install(() => {});
    try {
      expect(tracing.isCapturingMessagePayloads()).toBe(true);
    } finally {
      tap.uninstall();
    }
    expect(tracing.isCapturingMessagePayloads()).toBe(true);
  });

  test('on a quiet system the switch is still off after the detach', () => {
    const system = newSystem('capture-switch-off-quiet');
    const tracing = system.extension(TracingExtensionId);
    const tap = newTap(system, false);
    tap.install(() => {});
    tap.uninstall();
    expect(tracing.isCapturingMessagePayloads()).toBe(false);
  });

  test('switched on over a quiet system, detach still puts the switch back off', () => {
    // The #714 symmetry, unchanged by the option: the switch-on path is
    // the one the wave already pinned, and a fourth constructor argument
    // must not disturb it.
    const system = newSystem('capture-switch-on-quiet');
    const tracing = system.extension(TracingExtensionId);
    const tap = newTap(system, true);
    tap.install(() => {});
    expect(tracing.isCapturingMessagePayloads()).toBe(true);
    tap.uninstall();
    expect(tracing.isCapturingMessagePayloads()).toBe(false);
  });
});

describe('with the switch off the tee withholds nothing — DevTools flipped nothing', () => {
  test('a capture the application turns on mid-attach still reaches its own exporter', async () => {
    // The assertion that catches the too-narrow fix: reading the switch
    // at `captureMessagePayloads(true)` but still computing the withheld
    // set from `previousMessagePayloads` alone.  That tee is built with
    // `{actor.message.payload}` in it — the filter is fixed at install —
    // so an application that enables its own capture during the attach
    // has the attribute stripped out of its own export.  DevTools
    // declines to *add* an export; it must never remove one, and least
    // of all on the path where the operator asked it to capture nothing.
    const system = newSystem('capture-switch-off-application-enables-late');
    const tracing = system.extension(TracingExtensionId);
    const exporter = new RecordingTracer();
    tracing.enable(exporter);

    const tap = newTap(system, false);
    tap.install(() => {});
    try {
      tracing.captureMessagePayloads(true);
      const ref = system.spawn(OrderActor, 'orders');
      ref.tell({ kind: 'place', id: 7 });
      await settle();

      const exported = exporter.recorded()
        .filter((span) => span.attributes['actor.path']?.toString().endsWith('/orders') === true);
      expect(exported.length).toBeGreaterThan(0);
      expect(exported.filter((span) => span.attributes[PAYLOAD_ATTRIBUTE] !== undefined).length)
        .toBeGreaterThan(0);
    } finally {
      tap.uninstall();
    }
  });

  test('the foreign exporter keeps receiving spans — the tee is still a tee', async () => {
    const system = newSystem('capture-switch-off-tee-still-exports');
    const tracing = system.extension(TracingExtensionId);
    const exporter = new RecordingTracer();
    tracing.enable(exporter);

    const tap = newTap(system, false);
    tap.install(() => {});
    try {
      const ref = system.spawn(OrderActor, 'orders');
      ref.tell({ kind: 'place', id: 7 });
      await settle();

      const exported = exporter.recorded()
        .filter((span) => span.attributes['actor.path']?.toString().endsWith('/orders') === true);
      expect(exported.length).toBeGreaterThan(0);
      // Nothing in the process captured a body, so none is there to withhold.
      expect(exported.filter((span) => span.attributes[PAYLOAD_ATTRIBUTE] !== undefined))
        .toHaveLength(0);
    } finally {
      tap.uninstall();
    }
  });
});

describe('DevTools.attach carries the setting down to the tap', () => {
  /**
   * The wiring, end to end, and the reason it is asserted here rather
   * than left to the constructor: the fourth argument is defaulted, so a
   * `DevToolsServer` that never passed it would compile and silently
   * capture.  These two tests are what makes the pass-through observable.
   *
   * `port: 0` so nothing collides with a neighbouring worker — this
   * machine has excluded port ranges that make a fixed port a flake.
   */
  test('`withCapturePayloads(false)` attaches with the panel live and the capture off', async () => {
    const system = newSystem('capture-switch-attach-off');
    const options = DevToolsOptions.create()
      .withPort(0)
      .withCapturePayloads(false);
    const devtools = await DevTools.attach(system, options);
    try {
      expect(system.extension(TracingExtensionId).isCapturingMessagePayloads()).toBe(false);
      // Live, not switched off: `panels.tracing: false` is the other
      // setting and this one is deliberately not it.
      expect(system.extension(TracingExtensionId).isRecordingRootSpans()).toBe(true);
    } finally {
      await devtools.detach();
    }
  });

  test('attaching without the option captures, as it always did', async () => {
    const system = newSystem('capture-switch-attach-default');
    const devtools = await DevTools.attach(system, { port: 0 });
    try {
      expect(system.extension(TracingExtensionId).isCapturingMessagePayloads()).toBe(true);
    } finally {
      await devtools.detach();
    }
  });

  test('the HOCON leaf reaches the same place a code-set option does', async () => {
    // Acceptance criterion 2 end to end: a file is the only way an
    // operator who does not own the call site can set this.
    const config = Config.parseString(`
      actor-ts.devtools {
        port = 0
        capture-payloads = false
      }
    `);
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig(config);
    const system = ActorSystem.create('capture-switch-attach-hocon', options);
    systems.push(system);

    const devtools = await DevTools.attach(system);
    try {
      expect(system.extension(TracingExtensionId).isCapturingMessagePayloads()).toBe(false);
      expect(system.extension(TracingExtensionId).isRecordingRootSpans()).toBe(true);
    } finally {
      await devtools.detach();
    }
  });
});

describe('the attach warning stops claiming a switch it did not flip', () => {
  test('switched off, the warning names the span volume and not the payload', () => {
    // The line is the only place the difference is visible, so a sentence
    // that says DevTools attaches `actor.message.payload` while the
    // operator switched that off is prose asserting the opposite of the
    // code beside it.
    const logger = new RecordingLogger();
    const system = newSystem('capture-switch-off-warning', logger);
    system.extension(TracingExtensionId).enable(new RecordingTracer());

    const tap = newTap(system, false);
    tap.install(() => {});
    try {
      const line = logger.warnings.find((w) => w.includes('already tracing'));
      expect(line).toBeDefined();
      expect(line).toContain('root span per actor message');
      expect(line).not.toContain(PAYLOAD_ATTRIBUTE);
    } finally {
      tap.uninstall();
    }
  });

  test('switched off over a system already recording root spans, nothing is warned at all', () => {
    // Both halves unflipped: an attach that changes nothing for the
    // foreign exporter must say nothing, or the warning becomes one
    // nobody reads.
    const logger = new RecordingLogger();
    const system = newSystem('capture-switch-off-warning-silent', logger);
    const tracing = system.extension(TracingExtensionId);
    tracing.enable(new RecordingTracer());
    tracing.recordRootSpans(true);

    const tap = newTap(system, false);
    tap.install(() => {});
    try {
      expect(logger.warnings.filter((w) => w.includes('already tracing'))).toHaveLength(0);
    } finally {
      tap.uninstall();
    }
  });

  test('switched on, the payload half of the warning is still there', () => {
    const logger = new RecordingLogger();
    const system = newSystem('capture-switch-on-warning', logger);
    system.extension(TracingExtensionId).enable(new RecordingTracer());

    const tap = newTap(system, true);
    tap.install(() => {});
    try {
      const line = logger.warnings.find((w) => w.includes('already tracing'));
      expect(line).toBeDefined();
      expect(line).toContain(PAYLOAD_ATTRIBUTE);
    } finally {
      tap.uninstall();
    }
  });
});
