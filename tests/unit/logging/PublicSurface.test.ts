import { describe, expect, it } from 'bun:test';
import * as actorTs from '../../../src/index.js';

/**
 * Every log sink has to be reachable through the package root.
 *
 * The package publishes `.`, `./testkit` and `./devtools` — nothing else —
 * so a symbol missing from `src/index.ts` is a symbol no user can import,
 * however complete the implementation behind it is.
 *
 * **`bun run typecheck` cannot catch this.**  A re-export that was never
 * written is not a type error, and every other test in this directory
 * imports from `src/logging/…` directly, so a sink can be fully exercised
 * while the only path a user has does not exist.  That happened: four
 * sinks shipped unimportable.  This file exists to make the next one fail
 * loudly instead.
 */

/** Sinks in the order a reader would meet them in the docs. */
const SINK_CLASSES = [
  'ConsoleSink',
  'FileSink',
  'OtlpHttpSink',
  'GelfSink',
  'ParseableSink',
  'LokiSink',
  'SeqSink',
  'SplunkSink',
  'SyslogSink',
] as const;

/** Every options family, which must expose the builder's `create()`. */
const OPTIONS_FAMILIES = [
  'MultiSinkLoggerOptions',
  'ConsoleSinkOptions',
  'FileSinkOptions',
  'OtlpHttpSinkOptions',
  'GelfSinkOptions',
  'ParseableSinkOptions',
  'SentrySinkOptions',
  'LokiSinkOptions',
  'SeqSinkOptions',
  'SplunkSinkOptions',
  'SyslogSinkOptions',
] as const;

/** What somebody writing their own sink needs to have in hand. */
const EXTENSION_POINTS = [
  'MultiSinkLogger',
  'BatchingSink',
  'SinkDeliveryError',
  'SinkReporter',
  'formatTextLine',
  'formatJsonLine',
  'buildLoggerFromConfig',
] as const;

const surface = actorTs as unknown as Record<string, unknown>;

describe('the logging surface is reachable from the package root', () => {
  it.each(SINK_CLASSES)('exports %s', (name) => {
    expect(typeof surface[name]).toBe('function');
  });

  it('exports the Sentry sink as a factory, not a class', () => {
    // It mirrors `otelLogger`: the user's own SDK goes in, a sink comes out.
    expect(typeof surface['sentrySink']).toBe('function');
  });

  it.each(OPTIONS_FAMILIES)('exports %s with a create()', (name) => {
    const family = surface[name] as { create?: unknown } | undefined;
    expect(typeof family?.create).toBe('function');
  });

  it.each(EXTENSION_POINTS)('exports %s', (name) => {
    expect(surface[name]).toBeDefined();
  });

  it('exports every options builder and validator alongside the family', () => {
    for (const family of OPTIONS_FAMILIES) {
      expect(surface[`${family}Builder`], `${family}Builder`).toBeDefined();
      expect(surface[`${family}Validator`], `${family}Validator`).toBeDefined();
    }
  });
});

describe('the exported sinks are usable through the root import', () => {
  it('constructs each sink with the options family next to it', () => {
    // Not just "the symbol is there" — the pair has to actually work
    // together, which is what a user's first five minutes look like.
    const consoleSink = new actorTs.ConsoleSink(
      actorTs.ConsoleSinkOptions.create().withMinLevel(actorTs.LogLevel.Warn),
    );
    expect(consoleSink.minLevel).toBe(actorTs.LogLevel.Warn);

    const lokiSink = new actorTs.LokiSink(
      actorTs.LokiSinkOptions.create().withUrl('http://loki:3100'),
    );
    expect(lokiSink.name).toBe('loki');

    const syslogSink = new actorTs.SyslogSink(
      actorTs.SyslogSinkOptions.create().withHost('logs.internal'),
    );
    expect(syslogSink.name).toBe('syslog');
  });

  it('builds a MultiSinkLogger over sinks taken from the root', () => {
    const logger = new actorTs.MultiSinkLogger(
      actorTs.MultiSinkLoggerOptions.create().withSinks([new actorTs.ConsoleSink()]),
    );
    expect(logger.level).toBe(actorTs.LogLevel.Info);
  });
});
