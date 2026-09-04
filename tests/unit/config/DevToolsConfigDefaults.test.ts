import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { NoopLogger } from '../../../src/Logger.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { DevTools } from '../../../src/devtools/DevTools.js';
import {
  DEVTOOLS_DEFAULTS,
  mergeDevToolsOptions,
  readDevToolsOptionsFromConfig,
  DevToolsOptionsValidator,
} from '../../../src/devtools/DevToolsOptions.js';

/**
 * #881 — before this, DevTools was tunable only in code: there was no
 * `actor-ts.devtools` block at all, so enabling the tap in a container meant
 * a rebuild.  Three properties matter, and the third is the reason the issue
 * carries a `security` label.
 *
 *   1. the mapping — kebab HOCON leaf to camelCase option field, including
 *      the nested `panels` sub-block, and the `Ms` suffix the four interval
 *      fields keep in TypeScript and drop in HOCON;
 *   2. "absent means absent" — a key nobody set stays out of the returned
 *      object entirely, or it lands as an explicit `undefined` and shadows
 *      the built-in default underneath it;
 *   3. **a configured value faces the same guard a code-set one does.**  If
 *      it did not, `application.conf` — resolved from `ACTOR_TS_CONFIG` or
 *      a file dropped next to the process, and able to interpolate `${?ENV}`
 *      — would be a way around the loopback rule rather than a way to set a
 *      host.  `auth` and `ipAllowlist` are middleware with no HOCON form, so
 *      `allow-remote` is the only answer a file can give to that rule, which
 *      is exactly why it must be checked and not merely read.
 */

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) {
    await DevTools.detach(system);
    await system.terminate();
  }
});

/** A system whose config layer is the given HOCON, over `reference.conf`. */
function systemWith(hocon: string, name = 'devtools-config'): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

describe('readDevToolsOptionsFromConfig', () => {
  test('reads every leaf of the devtools block', () => {
    // `Config.parseString`, not `Config.fromObject({'actor-ts.devtools.port': …})`:
    // the latter keeps the dotted string as a literal top-level key, so
    // `hasPath` would resolve the nested reference.conf value instead and the
    // assertion below would be about the shipped defaults, not this block.
    const config = Config.parseString(`
      actor-ts.devtools {
        host = "10.0.0.5"
        port = 4444
        allow-remote = true
        serve-ui = false
        allowed-origins = ["https://ui.example"]
        panels {
          actors = false
          cluster = false
          tracing = false
          explain = false
          time-travel = false
          profiler = false
          dead-letters = false
          event-stream = false
          config = false
          send = false
        }
        mailbox-sample-interval = 2s
        mailbox-sample-limit = 16
        stats-interval = 500ms
        span-buffer-capacity = 128
        span-flush-interval = 100ms
        event-buffer-capacity = 64
        event-flush-interval = 50ms
        replay-auto-capture = false
      }
    `);

    expect(readDevToolsOptionsFromConfig(config)).toEqual({
      host: '10.0.0.5',
      port: 4444,
      allowRemote: true,
      serveUi: false,
      allowedOrigins: ['https://ui.example'],
      panels: {
        actors: false,
        cluster: false,
        tracing: false,
        explain: false,
        timeTravel: false,
        profiler: false,
        deadLetters: false,
        eventStream: false,
        config: false,
        send: false,
      },
      mailboxSampleIntervalMs: 2_000,
      mailboxSampleLimit: 16,
      statsIntervalMs: 500,
      spanBufferCapacity: 128,
      spanFlushIntervalMs: 100,
      eventBufferCapacity: 64,
      eventFlushIntervalMs: 50,
      replayAutoCapture: false,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expect(readDevToolsOptionsFromConfig(Config.parseString('actor-ts.system.name = x')))
      .toEqual({});
  });

  test('a block naming no panel leaves `panels` absent, not ten undefined switches', () => {
    // An empty `panels` object would survive the merge and replace a set of
    // switches the caller passed in code.
    const config = Config.parseString('actor-ts.devtools.port = 1234');
    expect(readDevToolsOptionsFromConfig(config)).toEqual({ port: 1234 });
  });

  test('the four interval leaves drop the `Ms` their fields keep', () => {
    const config = Config.parseString(`
      actor-ts.devtools {
        mailbox-sample-interval = 1500ms
        stats-interval = 3s
        span-flush-interval = 1s
        event-flush-interval = 2s
      }
    `);
    expect(readDevToolsOptionsFromConfig(config)).toEqual({
      mailboxSampleIntervalMs: 1_500,
      statsIntervalMs: 3_000,
      spanFlushIntervalMs: 1_000,
      eventFlushIntervalMs: 2_000,
    });
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    expect(readDevToolsOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toEqual({
      host: DEVTOOLS_DEFAULTS.host,
      port: DEVTOOLS_DEFAULTS.port,
      allowRemote: DEVTOOLS_DEFAULTS.allowRemote,
      serveUi: DEVTOOLS_DEFAULTS.serveUi,
      allowedOrigins: [],
      panels: {
        actors: true,
        cluster: true,
        tracing: true,
        explain: true,
        timeTravel: true,
        profiler: true,
        deadLetters: true,
        eventStream: true,
        config: true,
        send: true,
      },
      mailboxSampleIntervalMs: DEVTOOLS_DEFAULTS.mailboxSampleIntervalMs,
      mailboxSampleLimit: DEVTOOLS_DEFAULTS.mailboxSampleLimit,
      statsIntervalMs: DEVTOOLS_DEFAULTS.statsIntervalMs,
      spanBufferCapacity: DEVTOOLS_DEFAULTS.spanBufferCapacity,
      spanFlushIntervalMs: DEVTOOLS_DEFAULTS.spanFlushIntervalMs,
      eventBufferCapacity: DEVTOOLS_DEFAULTS.eventBufferCapacity,
      eventFlushIntervalMs: DEVTOOLS_DEFAULTS.eventFlushIntervalMs,
      replayAutoCapture: DEVTOOLS_DEFAULTS.replayAutoCapture,
    });
  });

  test('two acknowledgements are deliberately unreadable from a file', () => {
    // `allow-ungated-mount` states a fact about the code that binds mount()'s
    // routes, not about a deployment; `allow-message-sending` is the one
    // DevTools capability that writes into the running system from a browser.
    // Both stay code-only, so a file naming them changes nothing.
    const config = Config.parseString(`
      actor-ts.devtools {
        allow-ungated-mount = true
        allow-message-sending = true
      }
    `);
    expect(readDevToolsOptionsFromConfig(config)).toEqual({});
  });
});

describe('the devtools block goes through the same security rule as code', () => {
  test('a configured routable host is refused, naming the way out', async () => {
    const system = systemWith('actor-ts.devtools.host = "0.0.0.0"');
    // `attach` validates before it binds, so this rejects without opening a
    // port — and it is the whole point of the block: a host from a file is
    // not a way around the rule a host in code has to satisfy.
    await expect(DevTools.attach(system)).rejects.toThrow(OptionsError);
    try {
      await DevTools.attach(system);
    } catch (error) {
      expect((error as OptionsError).field).toBe('host');
      expect((error as OptionsError).message).toContain('allowRemote');
    }
  });

  test('a configured acknowledgement is honoured, exactly as a code-set one', () => {
    // Composed rather than attached: accepting the bind means *performing*
    // it, and a test that binds a wildcard interface is a firewall prompt on
    // someone's machine.  The two lines are the ones `createServer` runs, and
    // the test above proves it runs them.
    const settings = mergeDevToolsOptions(
      readDevToolsOptionsFromConfig(Config.parseString(`
        actor-ts.devtools { host = "0.0.0.0", allow-remote = true }
      `)),
      {},
    );
    expect(settings.host).toBe('0.0.0.0');
    expect(() => new DevToolsOptionsValidator('attach').validate(settings)).not.toThrow();
    // …and without the acknowledgement the same host is refused.
    const ungated = mergeDevToolsOptions(
      readDevToolsOptionsFromConfig(Config.parseString('actor-ts.devtools.host = "0.0.0.0"')),
      {},
    );
    expect(() => new DevToolsOptionsValidator('attach').validate(ungated)).toThrow(OptionsError);
  });

  test('an explicit host beats a configured one, in both directions', async () => {
    const system = systemWith('actor-ts.devtools.host = "0.0.0.0"');
    // Explicit options are the highest layer, so the code's loopback host
    // wins over the file's — and nothing is refused.
    const binding = await DevTools.attach(system, { host: '127.0.0.1', port: 0 });
    expect(binding.host).toBe('127.0.0.1');
  });

  test('a configured value cannot be reintroduced by an unrelated code option', async () => {
    // The other direction of the same precedence: setting a port in code does
    // not drag the configured host along past the guard.
    const system = systemWith('actor-ts.devtools.host = "0.0.0.0"');
    await expect(DevTools.attach(system, { port: 0 })).rejects.toThrow(OptionsError);
  });
});

describe('DevTools attached without options reflects the config block', () => {
  test('the running tap takes its host, port, UI and panels from the file', async () => {
    const system = systemWith(`
      actor-ts.devtools {
        port = 0
        serve-ui = false
        panels { profiler = false }
      }
    `, 'devtools-from-config');

    const binding = await DevTools.attach(system);
    expect(binding.host).toBe('127.0.0.1');
    expect(binding.port).toBeGreaterThan(0);
    // serve-ui = false: the tap answers, the UI does not.
    expect((await fetch(`${binding.url}/`)).status).toBe(404);

    const info = await (await fetch(`${binding.url}/api/info`)).json() as {
      panels: { id: string; status: string; reason?: string }[];
    };
    const profiler = info.panels.find((panel) => panel.id === 'profiler');
    expect(profiler?.status).toBe('disabled');
    expect(profiler?.reason).toContain('switched off');
    // Everything the file did not mention stays on.
    expect(info.panels.find((panel) => panel.id === 'tracing')?.status).toBe('active');
  });

  test('a panel object in code overrides the file switch by switch', async () => {
    // The one place the shallow merge would produce a surprising, security-
    // relevant result: replacing `panels` wholesale would switch the
    // operator's disabled panel back on because the caller mentioned an
    // unrelated one.
    const system = systemWith(`
      actor-ts.devtools {
        port = 0
        serve-ui = false
        panels { profiler = false }
      }
    `, 'devtools-panel-merge');

    const binding = await DevTools.attach(system, { panels: { tracing: false } });
    const info = await (await fetch(`${binding.url}/api/info`)).json() as {
      panels: { id: string; status: string }[];
    };
    expect(info.panels.find((panel) => panel.id === 'profiler')?.status).toBe('disabled');
    expect(info.panels.find((panel) => panel.id === 'tracing')?.status).toBe('disabled');
    expect(info.panels.find((panel) => panel.id === 'explain')?.status).toBe('active');
  });
});
