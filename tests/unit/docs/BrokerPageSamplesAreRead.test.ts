import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { readMqttOptionsFromConfig } from '../../../src/io/broker/MqttActor.js';
import { MqttOptionsValidator } from '../../../src/io/broker/MqttOptions.js';
import { readFramingFromConfig } from '../../../src/io/broker/TcpFraming.js';

/**
 * **The HOCON the MQTT and TCP pages publish configures what they say**
 * (#1443).
 *
 * `BrokerFenceKeys` holds an io page's fences to the paths `ConfigKeys`
 * declares and `HoconFenceKeys` holds them to kebab-case, so between them a
 * key is spelt and placed where a reader looks.  Neither runs a reader.  The
 * MQTT connection fence takes every leaf from the environment, and the
 * tcp-server fence its framing delimiter, so what a reader ends up with also
 * depends on the variable each leaf names — a variable spelt
 * `ACTOR_TS_MQTT_KEEPALIVE` passes both guards and configures nothing — and on
 * the JSON-first read of an environment value, which the MQTT page warns about.
 *
 * So each fence is read off its page, in both languages, parsed the way an
 * `application.conf` is, and run through the actor's own reader with the
 * page's variables unset and set: unset, the sample sets nothing; set, every
 * leaf reaches its option.  The values used are the ones the pages' prose
 * names: `30s` for keep-alive and a bare `30` refused, `1e3` and `1.50`
 * changing spelling unless quoted inside the variable.  The variables are
 * restored after every test.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

const LANGUAGES = [
  { language: 'English', ioDirectory: 'io' },
  { language: 'German', ioDirectory: 'de/io' },
] as const;

/** Every variable the two samples substitute. */
const VARIABLES = [
  'ACTOR_TS_MQTT_BROKER_URL',
  'ACTOR_TS_MQTT_CLIENT_ID',
  'ACTOR_TS_MQTT_USERNAME',
  'ACTOR_TS_MQTT_PASSWORD',
  'ACTOR_TS_MQTT_QOS',
  'ACTOR_TS_MQTT_CLEAN_SESSION',
  'ACTOR_TS_MQTT_KEEP_ALIVE',
  'ACTOR_TS_MQTT_PROTOCOL_VERSION',
  'ACTOR_TS_TCP_SERVER_DELIMITER',
  'ACTOR_TS_TCP_SERVER_MAX_FRAME_BYTES',
] as const;

type Variable = (typeof VARIABLES)[number];

/** What the process had before this file ran, put back after every test. */
const ORIGINAL_VALUES = new Map<Variable, string | undefined>(VARIABLES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of ORIGINAL_VALUES) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Every variable of the samples unset, then `values` set. */
function environment(values: Partial<Record<Variable, string>> = {}): void {
  for (const name of VARIABLES) delete process.env[name];
  Object.assign(process.env, values);
}

/** The one HOCON fence of `page` that holds `marker`, with the page's line endings normalised. */
function fenceHolding(page: string, marker: string): string {
  const text = readFileSync(join(DOCS_ROOT, page), 'utf8').replace(/\r\n/g, '\n');
  const fences = [...text.matchAll(/```hocon\n([\s\S]*?)\n```/g)].map((fence) => fence[1]!);
  const holding = fences.filter((fence) => fence.includes(marker));
  expect(holding, `${page} has no single HOCON fence holding "${marker}"`).toHaveLength(1);
  return holding[0]!;
}

const mqttFenceOf = (ioDirectory: string): string => fenceHolding(`${ioDirectory}/mqtt.mdx`, 'broker-url');
const tcpServerFenceOf = (ioDirectory: string): string =>
  fenceHolding(`${ioDirectory}/tcp.mdx`, 'actor-ts.io.broker.tcp-server');

describe('the HOCON the MQTT and TCP pages publish configures what they say (#1443)', () => {
  test('both languages publish the same two fences', () => {
    expect(mqttFenceOf('de/io')).toBe(mqttFenceOf('io'));
    expect(tcpServerFenceOf('de/io')).toBe(tcpServerFenceOf('io'));
  });

  test.each([...LANGUAGES])('$language: the MQTT connection fence sets nothing while its variables are unset', ({ ioDirectory }) => {
    environment();
    const { credentials, ...rest } = readMqttOptionsFromConfig(Config.parseString(mqttFenceOf(ioDirectory)));
    expect(rest).toEqual({});
    // The block stays, empty, once both of its leaves are unset.
    expect(credentials ?? {}).toEqual({});
  });

  test.each([...LANGUAGES])('$language: every MQTT leaf reaches its option from its variable, and the validator takes them', ({ ioDirectory }) => {
    environment({
      ACTOR_TS_MQTT_BROKER_URL: 'mqtts://mqtt.example.com:8883',
      ACTOR_TS_MQTT_CLIENT_ID: 'my-app',
      ACTOR_TS_MQTT_USERNAME: 'my-app',
      ACTOR_TS_MQTT_PASSWORD: 'secret',
      ACTOR_TS_MQTT_QOS: '1',
      ACTOR_TS_MQTT_CLEAN_SESSION: 'false',
      ACTOR_TS_MQTT_KEEP_ALIVE: '30s',
      ACTOR_TS_MQTT_PROTOCOL_VERSION: '5',
    });
    const options = readMqttOptionsFromConfig(Config.parseString(mqttFenceOf(ioDirectory)));
    expect(options).toEqual({
      brokerUrl: 'mqtts://mqtt.example.com:8883',
      clientId: 'my-app',
      credentials: { username: 'my-app', password: 'secret' },
      qos: 1,
      cleanSession: false,
      keepAlive: 30,
      protocolVersion: 5,
    });
    expect(() => new MqttOptionsValidator().validate(options)).not.toThrow();
  });

  test.each([...LANGUAGES])('$language: keep-alive from the environment takes 30s and refuses a bare 30, as the page says', ({ ioDirectory }) => {
    environment({ ACTOR_TS_MQTT_KEEP_ALIVE: '30' });
    expect(() => readMqttOptionsFromConfig(Config.parseString(mqttFenceOf(ioDirectory))))
      .toThrow(/keep-alive = 30 ms is not a whole number of seconds/);
    environment({ ACTOR_TS_MQTT_KEEP_ALIVE: '30s' });
    expect(readMqttOptionsFromConfig(Config.parseString(mqttFenceOf(ioDirectory))).keepAlive).toBe(30);
  });

  test.each([...LANGUAGES])('$language: a client id or password that reads as a number changes spelling unless quoted, as the page says', ({ ioDirectory }) => {
    environment({ ACTOR_TS_MQTT_CLIENT_ID: '1e3', ACTOR_TS_MQTT_USERNAME: 'my-app', ACTOR_TS_MQTT_PASSWORD: '1.50' });
    const plain = readMqttOptionsFromConfig(Config.parseString(mqttFenceOf(ioDirectory)));
    expect(plain.clientId).toBe('1000');
    expect(plain.credentials?.password).toBe('1.5');
    environment({ ACTOR_TS_MQTT_CLIENT_ID: '"1e3"', ACTOR_TS_MQTT_USERNAME: 'my-app', ACTOR_TS_MQTT_PASSWORD: '"1.50"' });
    const quoted = readMqttOptionsFromConfig(Config.parseString(mqttFenceOf(ioDirectory)));
    expect(quoted.clientId).toBe('1e3');
    expect(quoted.credentials?.password).toBe('1.50');
  });

  test.each([...LANGUAGES])('$language: the tcp-server framing is lines with its 64K cap, and the delimiter comes from its variable', ({ ioDirectory }) => {
    const keys = ConfigKeys.io.broker.tcpServer.framing;
    environment();
    expect(readFramingFromConfig(Config.parseString(tcpServerFenceOf(ioDirectory)), keys))
      .toEqual({ kind: 'lines', maxLineBytes: 64 * 1024 });
    // max-frame-bytes is shown commented out, because lines framing has no
    // frame cap: uncommented, it would be a line the reader never reads, and
    // the result would not change, so its absence is what is checked.
    environment({ ACTOR_TS_TCP_SERVER_DELIMITER: ';', ACTOR_TS_TCP_SERVER_MAX_FRAME_BYTES: '1K' });
    const configured = Config.parseString(tcpServerFenceOf(ioDirectory));
    expect(configured.hasPath(keys.maxFrameBytes), 'the lines sample sets max-frame-bytes, which lines framing never reads')
      .toBe(false);
    expect(readFramingFromConfig(configured, keys)).toEqual({ kind: 'lines', delimiter: ';', maxLineBytes: 64 * 1024 });
  });
});
