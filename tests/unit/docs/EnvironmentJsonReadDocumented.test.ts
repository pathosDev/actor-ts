/**
 * What an environment value that parses as JSON becomes, held to the pages
 * whose environment samples warn about it: the AMQP, MQTT and NATS pages
 * (#1443) and the upgrade guide's `APP_VERSION` (#843).
 *
 * `${?VAR}` hands the variable's text to `JSON.parse` first and keeps the raw
 * string only when that fails (`src/config/HoconParser.ts`), and every leaf
 * these pages take from the environment is then read as a string.  So a value
 * that reads as a number comes back in that number's own spelling — past
 * `Number.MAX_SAFE_INTEGER` possibly with other last digits — and one that
 * reads as `null`, a list or an object is a `ConfigError` that stops the
 * start.  The pages list those cases; each list is held here to what the
 * leaf's own reader returns, in English and in German, with the quoted output
 * computed rather than kept as a second copy of the words.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { readClusterOptionsFromConfig } from '../../../src/cluster/ClusterOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { readAmqpOptionsFromConfig } from '../../../src/io/broker/AmqpActor.js';
import { readMqttOptionsFromConfig } from '../../../src/io/broker/MqttActor.js';
import { readNatsOptionsFromConfig } from '../../../src/io/broker/NatsActor.js';

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** A whole number past `Number.MAX_SAFE_INTEGER` that a double cannot hold: the pages' example. */
const LARGE_WHOLE_NUMBER = '20261104123456789';

/** A page's prose: MDX comments and code fences cut, every run of whitespace folded to one space. */
function prose(relative: string): string {
  return readFileSync(join(DOCS_ROOT, relative), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gm, '')
    .replace(/\s+/g, ' ');
}

/** A leaf a page's sample takes from the environment, and the reader the actor's start calls for it. */
type Leaf = {
  readonly name: string;
  readonly variable: string;
  readonly hocon: string;
  readonly read: (config: Config) => unknown;
};

/** What `leaf` reads when its variable holds `value`; the variable is restored afterwards. */
function readWith(leaf: Leaf, value: string): unknown {
  const previous = process.env[leaf.variable];
  process.env[leaf.variable] = value;
  try {
    return leaf.read(Config.parseString(leaf.hocon));
  } finally {
    if (previous === undefined) delete process.env[leaf.variable];
    else process.env[leaf.variable] = previous;
  }
}

type Page = {
  readonly english: string;
  readonly german: string;
  readonly leaves: readonly Leaf[];
};

const PAGES: readonly Page[] = [
  {
    english: 'io/amqp.mdx',
    german: 'de/io/amqp.mdx',
    leaves: [{
      name: 'url',
      variable: 'ACTOR_TS_AMQP_URL',
      hocon: 'actor-ts.io.broker.amqp { url = ${?ACTOR_TS_AMQP_URL} }',
      read: (config) => readAmqpOptionsFromConfig(config).url,
    }],
  },
  {
    english: 'io/mqtt.mdx',
    german: 'de/io/mqtt.mdx',
    leaves: [
      {
        name: 'client-id',
        variable: 'ACTOR_TS_MQTT_CLIENT_ID',
        hocon: 'actor-ts.io.broker.mqtt { client-id = ${?ACTOR_TS_MQTT_CLIENT_ID} }',
        read: (config) => readMqttOptionsFromConfig(config).clientId,
      },
      {
        name: 'credentials.password',
        variable: 'ACTOR_TS_MQTT_PASSWORD',
        hocon: 'actor-ts.io.broker.mqtt { credentials { username = "my-app", password = ${?ACTOR_TS_MQTT_PASSWORD} } }',
        read: (config) => readMqttOptionsFromConfig(config).credentials?.password,
      },
    ],
  },
  {
    english: 'io/nats.mdx',
    german: 'de/io/nats.mdx',
    leaves: [{
      name: 'password',
      variable: 'ACTOR_TS_NATS_PASSWORD',
      hocon: 'actor-ts.io.broker.nats { password = ${?ACTOR_TS_NATS_PASSWORD} }',
      read: (config) => readNatsOptionsFromConfig(config).password,
    }],
  },
];

/** The upgrade guide's label, which `Cluster.join` reads from the same kind of substitution. */
const UPGRADE_PAGES: readonly Page[] = [
  {
    english: 'operations/upgrades/upgrade-strategies.mdx',
    german: 'de/operations/upgrades/upgrade-strategies.mdx',
    leaves: [{
      name: 'app-version',
      variable: 'APP_VERSION',
      hocon: 'actor-ts.cluster.app-version = ${?APP_VERSION}',
      read: (config) => readClusterOptionsFromConfig(config).appVersion,
    }],
  },
];

describe('an environment value that parses as JSON, as the io pages describe it (#1443)', () => {
  pinPages(PAGES);
});

describe('an environment value that parses as JSON, as the upgrade guide describes it for APP_VERSION (#843)', () => {
  pinPages(UPGRADE_PAGES);
});

/** Each page's leaves held to their reader, and the page in both languages to what the reader returns. */
function pinPages(pages: readonly Page[]): void {
  for (const page of pages) {
    for (const leaf of page.leaves) {
      test(`${page.english} ${leaf.name}: null, a list or an object stops the start with a ConfigError`, () => {
        for (const value of ['null', '[1,2]', '{"a":1}', '{}']) {
          expect(() => readWith(leaf, value)).toThrow(ConfigError);
        }
      });

      test(`${page.english} ${leaf.name}: a whole number past Number.MAX_SAFE_INTEGER can come back with other last digits`, () => {
        expect(Number(LARGE_WHOLE_NUMBER)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
        expect(readWith(leaf, LARGE_WHOLE_NUMBER)).not.toBe(LARGE_WHOLE_NUMBER);
      });
    }

    test(`${page.english} and ${page.german} list both cases`, () => {
      const outputs = page.leaves.map((leaf) => String(readWith(leaf, LARGE_WHOLE_NUMBER)));
      // One quoted output stands for every leaf of the page.
      expect(new Set(outputs).size).toBe(1);
      const output = outputs[0]!;
      const english = prose(page.english);
      expect(english).toContain('past `Number.MAX_SAFE_INTEGER`');
      expect(english).toContain(`(\`${LARGE_WHOLE_NUMBER}\` as \`${output}\`)`);
      expect(english).toContain('reads as `null`, a list or an object stops the start with a `ConfigError`');
      const german = prose(page.german);
      expect(german).toContain('jenseits von `Number.MAX_SAFE_INTEGER`');
      expect(german).toContain(`(\`${LARGE_WHOLE_NUMBER}\` als \`${output}\`)`);
      expect(german).toContain('wie `null`, eine Liste oder ein Objekt liest, lässt den Start mit einem `ConfigError` scheitern');
    });
  }
}
