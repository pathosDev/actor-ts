import { describe, expect, spyOn, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ConsoleLogger, LogLevel } from '../../../src/Logger.js';
import { LOG_LEVEL_NAMES, type LogLevelName, parseLogLevel } from '../../../src/logging/LogLevelName.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import type { LogSink } from '../../../src/logging/LogSink.js';

/**
 * `parseLogLevel` looks a configured word up in a table, and a configured word
 * is whatever somebody typed.  The table is an object literal, so a bare index
 * also answered for `constructor` and `__proto__` — the two members of
 * `Object.prototype` that survive the lower-casing — and handed back a function
 * and an object where a level belonged.  The system logger compared every
 * record against that and dropped all of them, `error()` included, and a
 * system with any sink refused to start: the outage the documented fallback to
 * `info` exists to prevent.
 *
 * The list is literal so a runtime cannot shrink it, and the first test holds
 * it to the runtime's own `Object.prototype` so it cannot fall behind either.
 */
const OBJECT_PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const;

const LEVEL_OF: Readonly<Record<LogLevelName, LogLevel>> = {
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
  off: LogLevel.Off,
};

class RecordingSink implements LogSink {
  readonly name = 'recording';
  readonly minLevel = LogLevel.Debug;
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

describe('the fixture', () => {
  test('names every own member of Object.prototype on this runtime', () => {
    for (const member of Object.getOwnPropertyNames(Object.prototype)) {
      expect(OBJECT_PROTOTYPE_NAMES as readonly string[]).toContain(member);
    }
  });
});

describe('parseLogLevel', () => {
  test('reads every level name, whatever its case and padding', () => {
    for (const name of LOG_LEVEL_NAMES) {
      expect(parseLogLevel(name)).toBe(LEVEL_OF[name]);
      expect(parseLogLevel(name.toUpperCase())).toBe(LEVEL_OF[name]);
      expect(parseLogLevel(` ${name}\t`)).toBe(LEVEL_OF[name]);
    }
  });

  for (const name of OBJECT_PROTOTYPE_NAMES) {
    test(`'${name}' is an unknown name in every spelling`, () => {
      for (const spelling of [name, name.toLowerCase(), name.toUpperCase(), ` ${name} `]) {
        expect(parseLogLevel(spelling)).toBeUndefined();
      }
    });
  }
});

describe('a system whose actor-ts.logger.level is an Object.prototype member', () => {
  test('without sinks, the console logger runs at info and error() still prints', async () => {
    const config = Config.parseString('actor-ts.logger.level = "constructor"');
    const systemOptions = ActorSystemOptions.create().withConfig(config);
    const system = ActorSystem.create('object-prototype-level-console', systemOptions);
    const printed = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(system.log).toBeInstanceOf(ConsoleLogger);
      expect(system.log.level).toBe(LogLevel.Info);
      system.log.error('still reported');
      expect(printed.mock.calls.some((call) => String(call[0]).includes('still reported'))).toBe(true);
    } finally {
      printed.mockRestore();
      await system.terminate();
    }
  });

  test('with a sink, the system starts and the sink receives records from info up', async () => {
    const sink = new RecordingSink();
    const config = Config.parseString('actor-ts.logger.level = "__proto__"');
    const systemOptions = ActorSystemOptions.create()
      .withLogSinks([sink])
      .withConfig(config);
    const system = ActorSystem.create('object-prototype-level-sink', systemOptions);
    try {
      expect(system.log.level).toBe(LogLevel.Info);
      system.log.debug('below the floor');
      system.log.info('at the floor');
      expect(sink.records.map((record) => record.message)).toEqual(['at the floor']);
    } finally {
      await system.terminate();
    }
  });
});
