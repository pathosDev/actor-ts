/**
 * MQTT broker actor — sensors publish temperature, an aggregator
 * subscribes to all of them via wildcards and prints a running average.
 *
 * Demonstrates **all three settings layers** documented in the plan:
 *
 *   1. Constructor settings — per-instance overrides (e.g. clientId).
 *   2. HOCON config under `actor-ts.io.broker.mqtt.*` — system-wide
 *      defaults (e.g. brokerUrl, credentials).
 *   3. Built-in defaults — kick in when neither of the above fired.
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
  Actor,
  ActorSystem,
  MqttActor,
  Props,
  type MqttMessage,
} from '../../src/index.js';

class Aggregator extends Actor<MqttMessage> {
  private readings: Record<string, number[]> = {};
  override onReceive(msg: MqttMessage): void {
    const sensorId = msg.topic.split('/')[1] ?? 'unknown';
    const value = Number(new TextDecoder().decode(msg.payload));
    if (!Number.isFinite(value)) return;
    const arr = (this.readings[sensorId] ??= []);
    arr.push(value);
    if (arr.length > 5) arr.shift();
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`[aggregator] ${sensorId}: ${value.toFixed(1)}°C  (avg over ${arr.length}: ${avg.toFixed(2)}°C)`);
  }
}

async function main(): Promise<void> {
  // The broker URL and credentials live in HOCON — typical for prod
  // (different per environment), while clientId is per-instance.
  const system = ActorSystem.create('mqtt-demo', {
    config: {
      'actor-ts': {
        io: {
          broker: {
            mqtt: {
              brokerUrl: 'mqtt://localhost:1883',
              // credentials: { username: "iot", password: ${MQTT_PASSWORD} }
              defaultQos: 1,
              keepAliveSec: 30,
            },
          },
        },
      },
    },
  });

  const aggregatorRef = system.actorOf(Props.create(() => new Aggregator()), 'agg');

  // Constructor settings = per-instance.  brokerUrl comes from HOCON.
  const mqttRef = system.actorOf(Props.create(() => new MqttActor({
    clientId: 'temperature-demo',
    subscriptions: [
      { topic: 'sensors/+/temp', target: aggregatorRef },
    ],
  })), 'mqtt');

  // Wait for connection, then start "sensors" — fake by self-publishing.
  await Bun.sleep(500);
  for (let i = 0; i < 10; i++) {
    const sensorId = ['kitchen', 'living-room', 'bedroom'][i % 3]!;
    const temp = (20 + Math.sin(i / 2) * 3 + Math.random()).toFixed(1);
    mqttRef.tell({
      kind: 'publish',
      publish: { topic: `sensors/${sensorId}/temp`, payload: temp, qos: 1 },
    });
    await Bun.sleep(200);
  }
  await Bun.sleep(500);
  await system.terminate();
}

void main();
