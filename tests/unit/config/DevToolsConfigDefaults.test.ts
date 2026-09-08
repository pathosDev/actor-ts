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
  type DevToolsOptionsType,
  type DevToolsPanelOptionsType,
} from '../../../src/devtools/DevToolsOptions.js';
import { helloFrame, type DevToolsServerFrame } from '../../../src/devtools/protocol/index.js';

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

/**
 * Open the tap socket, run one exchange, and always close it.
 *
 * The panel switches are checked here rather than only against
 * `/api/info` because the card's status is a statement about the UI and
 * the socket is where the data actually leaves the process: a panel whose
 * pull method is still registered serves payloads to any client that asks
 * for it by name, greyed-out card or not.
 */
async function withTapSocket<T>(
  url: string,
  exchange: (socket: WebSocket, next: () => Promise<DevToolsServerFrame>) => Promise<T>,
): Promise<T> {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/api/ws`);
  const inbox: DevToolsServerFrame[] = [];
  const waiters: ((frame: DevToolsServerFrame) => void)[] = [];
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as DevToolsServerFrame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else inbox.push(frame);
  });
  const next = (): Promise<DevToolsServerFrame> => {
    const buffered = inbox.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise<DevToolsServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a DevTools frame')), 5000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  };
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('websocket failed to open')));
  });
  try {
    return await exchange(socket, next);
  } finally {
    socket.close();
  }
}

/** Ask one pull method over the tap socket and return the answering frame. */
function requestOverTap(url: string, method: string): Promise<DevToolsServerFrame> {
  return withTapSocket(url, async (socket, next) => {
    socket.send(JSON.stringify(helloFrame()));
    await next();
    socket.send(JSON.stringify({ kind: 'request', requestId: 881, method }));
    return next();
  });
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
    // `toStrictEqual`, not `toEqual`: the latter ignores properties whose value
    // is `undefined`, so it cannot tell "absent" from "present and undefined" —
    // which is the only thing this test is about.  Measured while checking that
    // these tests bind: a reader written `out.port = hasPath ? read : undefined`
    // passed all twelve assertions in this file under `toEqual`.
    expect(readDevToolsOptionsFromConfig(Config.parseString('actor-ts.system.name = x')))
      .toStrictEqual({});
  });

  test('a block naming no panel leaves `panels` absent, not ten undefined switches', () => {
    // An empty `panels` object would survive the merge and replace a set of
    // switches the caller passed in code.
    const config = Config.parseString('actor-ts.devtools.port = 1234');
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({ port: 1234 });
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
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({
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
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({});
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

/**
 * Every panel leaf paired with the field it must set.
 *
 * The pairing itself is the property, so it is walked one row at a time.
 * The two tests further up cannot see it: the mapping test sets all ten
 * leaves to `false` and the reference.conf test reads all ten as `true`,
 * so both are invariant under *any* permutation of the ten reads — a
 * reader answering `time-travel` out of the `explain` leaf left the whole
 * file green when it was measured.  Nine of the ten switches could be
 * cross-wired to each other that way, and three of them —
 * {@link DevToolsPanelOptionsType.timeTravel},
 * {@link DevToolsPanelOptionsType.deadLetters} and
 * {@link DevToolsPanelOptionsType.eventStream} — are the ones
 * `reference.conf` itself names as surfacing message payloads, which
 * makes a misdirected switch a disclosure rather than a nuisance.  #881.
 */
const PANEL_SWITCHES: ReadonlyArray<readonly [string, keyof DevToolsPanelOptionsType]> = [
  ['actors', 'actors'],
  ['cluster', 'cluster'],
  ['tracing', 'tracing'],
  ['explain', 'explain'],
  ['time-travel', 'timeTravel'],
  ['profiler', 'profiler'],
  ['dead-letters', 'deadLetters'],
  ['event-stream', 'eventStream'],
  ['config', 'config'],
  ['send', 'send'],
];

describe('each panel leaf reaches its own switch and no other', () => {
  for (const [leaf, field] of PANEL_SWITCHES) {
    test(`\`${leaf}\` on its own lands on \`${field}\``, () => {
      // The `hasPath` half of the pairing.  With nine leaves absent, a
      // guard naming the wrong one sees nothing at all, and the strict
      // comparison also refuses a second switch appearing beside the one
      // that was actually set.
      const config = Config.parseString(`actor-ts.devtools.panels { ${leaf} = false }`);
      expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({ panels: { [field]: false } });
    });

    test(`\`${leaf} = false\` switches off \`${field}\` and leaves the other nine on`, () => {
      // The `getBoolean` half.  With all ten present a swapped read still
      // finds a value — the wrong one — so only a leaf whose value differs
      // from its neighbours' can tell them apart.
      const block = PANEL_SWITCHES
        .map(([name]) => `  ${name} = ${name === leaf ? 'false' : 'true'}`)
        .join('\n');
      const expected = Object.fromEntries(
        PANEL_SWITCHES.map(([, name]) => [name, name !== field]),
      );
      const read = readDevToolsOptionsFromConfig(
        Config.parseString(`actor-ts.devtools.panels {\n${block}\n}`),
      );
      expect(read.panels).toStrictEqual(expected);
    });
  }
});

/**
 * The same blindness one level up: three booleans read in a row out of
 * the same block, and the mapping test gives two of them the same value.
 */
const BOOLEAN_LEAVES: ReadonlyArray<readonly [string, keyof DevToolsOptionsType]> = [
  ['allow-remote', 'allowRemote'],
  ['serve-ui', 'serveUi'],
  ['replay-auto-capture', 'replayAutoCapture'],
];

describe('each boolean leaf of the devtools block reaches its own field', () => {
  for (const [leaf, field] of BOOLEAN_LEAVES) {
    test(`\`${leaf}\` on its own lands on \`${field}\``, () => {
      const config = Config.parseString(`actor-ts.devtools { ${leaf} = false }`);
      expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({ [field]: false });
    });
  }

  test('all three at once, each with its own value', () => {
    // `allow-remote` differs from the other two, which are the pair the
    // mapping test above sets to the same `false` and `reference.conf`
    // publishes as the same `true` — invariant under a swap either way.
    const config = Config.parseString(`
      actor-ts.devtools {
        allow-remote = true
        serve-ui = true
        replay-auto-capture = false
      }
    `);
    expect(readDevToolsOptionsFromConfig(config)).toStrictEqual({
      allowRemote: true,
      serveUi: true,
      replayAutoCapture: false,
    });
  });
});

/**
 * The three panels `reference.conf` names as the ones that surface message
 * payloads, taken end to end the way `profiler` and `tracing` already are.
 *
 * `method` is a pull operation registered *inside* that panel's
 * `isPanelEnabled` branch in `DevToolsServer.start`, so it is available
 * exactly when the panel is — which is the assertion that says the data
 * cannot leave the process, as opposed to merely being hidden.
 */
const PAYLOAD_PANELS = [
  { leaf: 'time-travel', id: 'time-travel', method: 'journal.ids', stream: undefined },
  { leaf: 'dead-letters', id: 'dead-letters', method: 'deadletters.list', stream: undefined },
  { leaf: 'event-stream', id: 'event-stream', method: 'pubsub.topics', stream: 'events' },
] as const;

describe('a payload-surfacing panel switched off in a file serves nothing', () => {
  test('with no panels block every one of the three answers', async () => {
    // The positive control the three tests below need: `unavailable`
    // there has to mean "this switch turned it off", not "this method is
    // never registered on a system shaped like the fixture".
    const system = systemWith(`
      actor-ts.devtools { port = 0, serve-ui = false }
    `, 'devtools-payload-panels-on');
    const binding = await DevTools.attach(system);

    const info = await (await fetch(`${binding.url}/api/info`)).json() as {
      streams: string[];
      panels: { id: string; status: string }[];
    };
    expect(info.streams).toContain('events');
    for (const panel of PAYLOAD_PANELS) {
      expect(info.panels.find((entry) => entry.id === panel.id)?.status).not.toBe('disabled');
      const frame = await requestOverTap(binding.url, panel.method);
      expect(frame.kind).toBe('response');
    }
  });

  for (const panel of PAYLOAD_PANELS) {
    test(`\`${panel.leaf} = false\` disables ${panel.id} and refuses its data`, async () => {
      const system = systemWith(`
        actor-ts.devtools {
          port = 0
          serve-ui = false
          panels { ${panel.leaf} = false }
        }
      `, `devtools-off-${panel.id}`);
      const binding = await DevTools.attach(system);

      const info = await (await fetch(`${binding.url}/api/info`)).json() as {
        streams: string[];
        panels: { id: string; status: string; reason?: string }[];
      };
      const target = info.panels.find((entry) => entry.id === panel.id);
      expect(target?.status).toBe('disabled');
      expect(target?.reason).toContain('switched off');
      // …and it is *this* panel that went off.  The three share a block,
      // a shape and a default, so a switch wired to a sibling would still
      // produce one greyed-out card and satisfy the assertion above.
      for (const other of PAYLOAD_PANELS) {
        if (other.id === panel.id) continue;
        expect(info.panels.find((entry) => entry.id === other.id)?.status).not.toBe('disabled');
      }
      if (panel.stream !== undefined) expect(info.streams).not.toContain(panel.stream);

      const frame = await requestOverTap(binding.url, panel.method);
      expect(frame.kind).toBe('error');
      if (frame.kind !== 'error') throw new Error('expected an error frame');
      expect(frame.code).toBe('unavailable');
      // Names the method, so this is "no handler is registered" and not
      // the hub's in-flight cap refusing with the same code.
      expect(frame.message).toContain(panel.method);
      expect(frame.requestId).toBe(881);
    });
  }
});
