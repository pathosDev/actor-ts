/**
 * gRPC client + server in one process.  Demonstrates:
 *   - GrpcServerActor exposing a unary `GetSensor` and a server-stream
 *     `WatchSensor` method.
 *   - GrpcClientActor calling both, with replies / stream chunks routed
 *     to handler actors.
 *   - Settings driven by both constructor (per-instance) and HOCON
 *     (system-wide endpoint).
 *
 * Requires:
 *   npm install @grpc/grpc-js @grpc/proto-loader
 *
 * Run:
 *   bun run examples/io/grpc-sensor.ts
 *
 * The .proto file lives next to this script (`sensor.proto`).
 */
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import {
  Actor,
  ActorSystem,
  GrpcClientActor,
  GrpcClientOptions,
  GrpcServerActor,
  GrpcServerOptions,
  Props,
  type GrpcInbound,
  type GrpcServerStreamCall,
  type GrpcUnaryCall,
} from '../../src/index.js';

// --- proto definition (inlined for self-contained example) -----------------

const PROTO = `
syntax = "proto3";
package sensor.v1;

service SensorService {
  rpc GetSensor   (GetReq)    returns (Sensor);
  rpc WatchSensor (WatchReq)  returns (stream Reading);
}

message GetReq   { string id = 1; }
message WatchReq { string id = 1; uint32 limit = 2; }
message Sensor   { string id = 1; string label = 2; }
message Reading  { double value = 1; uint64 ts = 2; }
`;

// --- handler actors --------------------------------------------------------

class GetSensorHandler extends Actor<GrpcUnaryCall> {
  override onReceive(call: GrpcUnaryCall): void {
    const id = (call.request as { id: string }).id;
    call.respond({ id, label: `sensor-${id}` });
  }
}

class WatchSensorHandler extends Actor<GrpcServerStreamCall> {
  override onReceive(call: GrpcServerStreamCall): void {
    const limit = (call.request as { limit?: number }).limit ?? 5;
    let i = 0;
    const tick = setInterval(() => {
      if (i >= limit) {
        clearInterval(tick);
        call.complete();
        return;
      }
      call.send({ value: 20 + Math.sin(i) * 3, ts: BigInt(Date.now()) as unknown as number });
      i++;
    }, 100);
  }
}

class ReplyCollector extends Actor<GrpcInbound> {
  override onReceive(msg: GrpcInbound): void {
    if (msg.kind === 'reply') {
      console.log('[client] unary reply:', msg.response);
    } else if (msg.kind === 'stream-data') {
      console.log('[client] stream chunk:', msg.chunk);
    } else if (msg.kind === 'stream-end') {
      console.log('[client] stream complete');
    } else if (msg.kind === 'rpc-error' || msg.kind === 'stream-error') {
      console.error('[client] error:', msg.error.message);
    }
  }
}

async function main(): Promise<void> {
  const protoPath = join(import.meta.dir, '_sensor-tmp.proto');
  writeFileSync(protoPath, PROTO);

  try {
    const sys = ActorSystem.create('grpc-demo');

    // Server side.
    const getHandler = sys.spawn(Props.create(() => new GetSensorHandler()), 'get');
    const watchHandler = sys.spawn(Props.create(() => new WatchSensorHandler()), 'watch');
    const serverOptions = GrpcServerOptions.create()
      .withProtoPath(protoPath)
      .withPackageName('sensor.v1')
      .withServiceName('SensorService')
      .withBind('127.0.0.1:50051')
      .withHandlers({
        GetSensor: { kind: 'unary', target: getHandler },
        WatchSensor: { kind: 'serverStream', target: watchHandler },
      });
    const server = sys.spawn(Props.create(() => new GrpcServerActor(serverOptions)), 'server');
    void server;

    await Bun.sleep(300);  // let the server bind

    // Client side.
    const collector = sys.spawn(Props.create(() => new ReplyCollector()), 'collector');
    const clientOptions = GrpcClientOptions.create()
      .withProtoPath(protoPath)
      .withPackageName('sensor.v1')
      .withServiceName('SensorService')
      .withEndpoint('127.0.0.1:50051');
    const client = sys.spawn(Props.create(() => new GrpcClientActor(clientOptions)), 'client');

    await Bun.sleep(300);

    client.tell({ kind: 'unary', method: 'GetSensor', request: { id: 'rt-7' }, target: collector });
    client.tell({
      kind: 'serverStream', method: 'WatchSensor',
      request: { id: 'rt-7', limit: 5 }, target: collector,
    });

    await Bun.sleep(1_500);
    await sys.terminate();
  } finally {
    try { unlinkSync(protoPath); } catch { /* ignore */ }
  }
}

void main();
