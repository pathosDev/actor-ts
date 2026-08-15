/**
 * gRPC client + server in one process.  Demonstrates:
 *   - GrpcServerActor exposing a unary `GetSensor`, a server-stream
 *     `WatchSensor` and a client-stream `ReportReadings` method.
 *   - GrpcClientActor calling all three, with replies / stream chunks
 *     routed to handler actors.
 *   - The client-stream handshake: `clientStreamStart` answers with a
 *     `stream-started` frame carrying the write capability, and the
 *     RPC's single response comes back as an ordinary `reply`.
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
import { match, P } from 'ts-pattern';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import {
  Actor,
  ActorSystem,
  type ActorRef,
} from '../../src/index.js';
import {
  GrpcClientActor,
  GrpcClientOptions,
  GrpcServerActor,
  GrpcServerOptions,
  type GrpcChunkMessage,
  type GrpcClientCommand,
  type GrpcClientStreamCall,
  type GrpcInbound,
  type GrpcRequestStreamInbound,
  type GrpcServerStreamCall,
  type GrpcUnaryCall,
  type ReplyMessage,
  type RpcErrorMessage,
  type StreamDataMessage,
  type StreamErrorMessage,
  type StreamStartedMessage,
} from '../../src/io/index.js';

// --- proto definition (inlined for self-contained example) -----------------

const PROTO = `
syntax = "proto3";
package sensor.v1;

service SensorService {
  rpc GetSensor      (GetReq)           returns (Sensor);
  rpc WatchSensor    (WatchReq)         returns (stream Reading);
  rpc ReportReadings (stream Reading)   returns (Summary);
}

message GetReq   { string id = 1; }
message WatchReq { string id = 1; uint32 limit = 2; }
message Sensor   { string id = 1; string label = 2; }
message Reading  { double value = 1; uint64 ts = 2; }
message Summary  { uint32 count = 1; double average = 2; }
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

/**
 * Server side of a client-streaming RPC: consume the request stream,
 * answer exactly once when the client half-closes.
 */
class ReportReadingsHandler extends Actor<GrpcClientStreamCall> {
  override onReceive(call: GrpcClientStreamCall): void {
    let count = 0;
    let total = 0;
    const onChunk = (m: GrpcChunkMessage): void => {
      total += (m.chunk as { value?: number }).value ?? 0;
      count += 1;
    };
    const onEnd = (): void => {
      call.respond({ count, average: count === 0 ? 0 : total / count });
    };
    // The sink is a plain `ActorRef` shape, so the running totals can
    // live in this closure instead of in actor fields.
    const sink: ActorRef<GrpcRequestStreamInbound> = {
      tell: (m: GrpcRequestStreamInbound): void => {
        match(m)
          .with({ kind: 'chunk' }, (c) => onChunk(c))
          .with({ kind: 'end' }, () => onEnd())
          .exhaustive();
      },
    } as unknown as ActorRef<GrpcRequestStreamInbound>;
    call.onData(sink);
  }
}

class ReplyCollector extends Actor<GrpcInbound> {
  /** Set once the client-stream handshake lands — see `onStreamStarted`. */
  constructor(private readonly client: ActorRef<GrpcClientCommand>) { super(); }

  override onReceive(message: GrpcInbound): void {
    match(message)
      .with({ kind: 'reply' }, (m) => this.onReply(m))
      .with({ kind: 'stream-started' }, (m) => this.onStreamStarted(m))
      .with({ kind: 'stream-data' }, (m) => this.onStreamData(m))
      .with({ kind: 'stream-end' }, () => this.onStreamEnd())
      // Unary and streaming failures read the same on the console, so one
      // arm covers both rather than two identical handlers.
      .with(P.union({ kind: 'rpc-error' }, { kind: 'stream-error' }), (m) => this.onError(m))
      .exhaustive();
  }

  private onReply(message: ReplyMessage): void {
    console.log('[client] unary reply:', message.response);
  }

  /**
   * The client stream is open.  `message.handle` is the write
   * capability — an unguessable token, not the bare stream number — so
   * push the readings through it and half-close.  The server's single
   * `Summary` then arrives as an ordinary `reply`.
   */
  private onStreamStarted(message: StreamStartedMessage): void {
    const handle = message.handle;
    console.log('[client] client stream open, id', handle.streamId);
    for (const value of [21.5, 22.0, 20.5, 23.0]) {
      this.client.tell({ kind: 'clientStreamSend', handle, chunk: { value, ts: 0 } });
    }
    this.client.tell({ kind: 'clientStreamClose', handle });
  }

  private onStreamData(message: StreamDataMessage): void {
    console.log('[client] stream chunk:', message.chunk);
  }

  private onStreamEnd(): void {
    console.log('[client] stream complete');
  }

  private onError(message: RpcErrorMessage | StreamErrorMessage): void {
    console.error('[client] error:', message.error.message);
  }
}

async function main(): Promise<void> {
  const protoPath = join(import.meta.dir, '_sensor-tmp.proto');
  writeFileSync(protoPath, PROTO);

  try {
    const sys = ActorSystem.create('grpc-demo');

    // Server side.
    const getHandler = sys.spawn(GetSensorHandler, 'get');
    const watchHandler = sys.spawn(WatchSensorHandler, 'watch');
    const reportHandler = sys.spawn(ReportReadingsHandler, 'report');
    const serverOptions = GrpcServerOptions.create()
      .withProtoPath(protoPath)
      .withPackageName('sensor.v1')
      .withServiceName('SensorService')
      .withBind('127.0.0.1:50051')
      .withHandlers({
        GetSensor: { kind: 'unary', target: getHandler },
        WatchSensor: { kind: 'serverStream', target: watchHandler },
        ReportReadings: { kind: 'clientStream', target: reportHandler },
      });
    const server = sys.spawn(() => new GrpcServerActor(serverOptions), 'server');
    void server;

    await Bun.sleep(300);  // let the server bind

    // Client side.  The client is spawned first: the collector needs it
    // to answer the client-stream handshake, which is what the factory
    // form of `spawn` is for (a constructor argument, not a closure
    // around configuration).
    const clientOptions = GrpcClientOptions.create()
      .withProtoPath(protoPath)
      .withPackageName('sensor.v1')
      .withServiceName('SensorService')
      .withEndpoint('127.0.0.1:50051');
    const client = sys.spawn(() => new GrpcClientActor(clientOptions), 'client');
    const collector = sys.spawn(
      () => new ReplyCollector(client as unknown as ActorRef<GrpcClientCommand>),
      'collector',
    );

    await Bun.sleep(300);

    client.tell({ kind: 'unary', method: 'GetSensor', request: { id: 'rt-7' }, target: collector });
    client.tell({
      kind: 'serverStream', method: 'WatchSensor',
      request: { id: 'rt-7', limit: 5 }, target: collector,
    });
    // Client streaming: open the stream — the collector picks the
    // handle up from the `stream-started` frame and pushes the readings.
    client.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: collector });

    await Bun.sleep(1_500);
    await sys.terminate();
  } finally {
    try { unlinkSync(protoPath); } catch { /* ignore */ }
  }
}

void main();
