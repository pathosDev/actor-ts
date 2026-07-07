/**
 * MQTT broker actor — a typed subclass that subscribes to all sensors
 * via a wildcard, decodes each reading, and prints a running average.
 *
 * Demonstrates the subclass-first API:
 *
 *   - extend `MqttActor<Reading>` and declare subscriptions in the ctor
 *   - handle inbound traffic in `onMessage` with `payload.entity()`
 *   - configure with the fluent `MqttOptions` builder
 *   - publish typed entities and raw payloads with `publish(...)`
 *
 * ...and **all three settings layers**:
 *
 *   1. Constructor / builder — per-instance overrides (e.g. clientId).
 *   2. HOCON under `actor-ts.io.broker.mqtt.*` — system-wide defaults.
 *   3. Built-in defaults — when neither of the above fired.
 *
 * Requires a running MQTT broker on localhost:1883.  Quick start:
 *
 *   docker run --rm -p 1883:1883 eclipse-mosquitto
 *   bun run examples/io/mqtt-temperature.ts
 *
 *   docker run --rm -p 1883:1883 -p 9001:9001 eclipse-mosquitto:2 \
 *     mosquitto -c /mosquitto-no-auth.conf
 */
import {
  ActorSystem,
  ActorSystemOptions,
  MqttActor,
  MqttOptions,
  Props,
  type MqttMessage,
} from '../../src/index.js';

type Reading = { sensor: string; celsius: number };

/** A self-tick that drives fake sensor publishes from inside the actor. */
type Tick = { kind: 'tick'; i: number };

class TemperatureHub extends MqttActor<Reading, Tick> {
  private readings: Record<string, number[]> = {};

  constructor(opts: MqttOptions) {
    // Builder-supplied clientId + QoS layer on top of the HOCON brokerUrl.
    super(opts.withClientId('temperature-demo').withQos(1));
    this.subscribe('sensors/+/temp');
  }

  override onMessage(msg: MqttMessage<Reading>): void {
    const { sensor, celsius } = msg.payload.entity();
    const arr = (this.readings[sensor] ??= []);
    arr.push(celsius);
    if (arr.length > 5) arr.shift();
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`[hub] ${sensor}: ${celsius.toFixed(1)}°C  (avg over ${arr.length}: ${avg.toFixed(2)}°C)`);
  }

  protected override onConnected(): void {
    this.log.info('MQTT connected — starting fake sensors');
    // Kick off a self-driven publish loop.
    this.self.tell({ kind: 'tick', i: 0 });
  }

  protected override onSelfMessage(msg: Tick): void {
    if (msg.i >= 10) return;
    const sensor = ['kitchen', 'living-room', 'bedroom'][msg.i % 3]!;
    const celsius = 20 + Math.sin(msg.i / 2) * 3 + Math.random();
    // Typed entity → encoded via the actor's codec (JSON by default).
    this.publish(`sensors/${sensor}/temp`, { sensor, celsius } satisfies Reading, { qos: 1 });
    this.context.timers.startSingleTimer(`tick-${msg.i}`, { kind: 'tick', i: msg.i + 1 }, 200);
  }
}

async function main(): Promise<void> {
  // The broker URL lives in HOCON — typical for prod (per-environment),
  // while clientId + QoS are set per-instance via the builder.
  const system = ActorSystem.create('mqtt-demo', ActorSystemOptions.create()
    .withConfig({
      'actor-ts': {
        io: {
          broker: {
            mqtt: {
              brokerUrl: 'mqtt://localhost:1883',
              // credentials: { username: "iot", password: ${MQTT_PASSWORD} }
              keepAlive: 30,
            },
          },
        },
      },
    }));

  system.spawn(
    Props.create(() => new TemperatureHub(MqttOptions.create())),
    'temperature-hub',
  );

  await Bun.sleep(3_000);
  await system.terminate();
}

void main();
