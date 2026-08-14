import { describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/index.js';
import * as logging from '../../../src/logging/index.js';

/**
 * Every log sink has to be reachable through the `actor-ts/logging` entry.
 *
 * Since the core-only root cut (#414) the package root carries only the
 * Logger primitives (`Logger`, `LogLevel`, `ConsoleLogger`, …); the sinks,
 * their options families and `buildLoggerFromConfig` are published solely
 * by `./logging` — so a symbol missing from `src/logging/index.ts` is a
 * symbol no user can import, however complete the implementation behind it
 * is.
 *
 * **`bun run typecheck` cannot catch this.**  A re-export that was never
 * written is not a type error, and every other test in this directory
 * imports the concrete sink modules directly, so a sink can be fully
 * exercised while the only path a user has does not exist.  That happened:
 * four sinks shipped unimportable.  This file exists to make the next one
 * fail loudly instead.
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

const surface = logging as unknown as Record<string, unknown>;

describe('the logging surface is reachable from the actor-ts/logging entry', () => {
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

describe('the exported sinks are usable through the logging entry', () => {
  it('constructs each sink with the options family next to it', () => {
    // Not just "the symbol is there" — the pair has to actually work
    // together, which is what a user's first five minutes look like.
    const consoleSink = new logging.ConsoleSink(
      logging.ConsoleSinkOptions.create().withMinLevel(LogLevel.Warn),
    );
    expect(consoleSink.minLevel).toBe(LogLevel.Warn);

    const lokiSink = new logging.LokiSink(
      logging.LokiSinkOptions.create().withUrl('http://loki:3100'),
    );
    expect(lokiSink.name).toBe('loki');

    const syslogSink = new logging.SyslogSink(
      logging.SyslogSinkOptions.create().withHost('logs.internal'),
    );
    expect(syslogSink.name).toBe('syslog');
  });

  it('builds a MultiSinkLogger over sinks taken from the logging entry', () => {
    const logger = new logging.MultiSinkLogger(
      logging.MultiSinkLoggerOptions.create().withSinks([new logging.ConsoleSink()]),
    );
    expect(logger.level).toBe(LogLevel.Info);
  });
});
