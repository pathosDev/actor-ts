/**
 * gRPC live-integration runner (B.8 / Closes #296).
 *
 * Spawns a GrpcServerActor + a GrpcClientActor in the same
 * ActorSystem, both pointed at the same `echo.proto`.  Each
 * scenario exercises one call class.
 */
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { GrpcClientActor, type GrpcInbound } from '../../../../src/io/broker/GrpcClientActor.js';
import { GrpcClientOptions } from '../../../../src/io/broker/GrpcClientOptions.js';
import {
  GrpcServerActor,
  type GrpcChunkMessage,
  type GrpcRequestStreamInbound,
  type GrpcUnaryCall,
  type GrpcServerStreamCall,
  type GrpcClientStreamCall,
  type GrpcBidiCall,
} from '../../../../src/io/broker/GrpcServerActor.js';
import { GrpcServerOptions } from '../../../../src/io/broker/GrpcServerOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioContext } from '../lib/Scenario.js';
import { scenario as unaryScenario } from './scenarios/01-unary.js';
import { scenario as serverStreamScenario } from './scenarios/02-server-stream.js';
import { scenario as bidiScenario } from './scenarios/03-bidi.js';
import { scenario as clientStreamScenario } from './scenarios/04-client-stream.js';
import { scenario as deadlineScenario } from './scenarios/05-deadline.js';
import { scenario as metadataScenario } from './scenarios/06-metadata.js';

export interface GrpcContext extends BrokerScenarioContext {
  readonly endpoint: string;
  readonly system: ActorSystem;
  readonly client: ActorRef<unknown>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

/* --------------------------- Server-side handlers ----------------------- */

/**
 * Request text the unary handler deliberately never answers.
 *
 * The deadline scenario (#577) needs the one thing an echo server does
 * not naturally provide — a call that hangs — and a hostile-server
 * container would be a lot of machinery for one assertion.
 */
export const HANG_REQUEST_TEXT = '__hang__';

/**
 * Request text that makes the unary handler answer with the header names
 * it was handed, rather than with an echo.
 *
 * The unit suite drives `extractMetadata` through a fake whose `getMap`
 * this repository writes, so it can prove the extraction logic and
 * nothing about grpc-js.  Were the real `Metadata` to lack that method,
 * every record would quietly go back to `{}` — #611's defect restored,
 * with a green unit suite.  Only a live call can see that.
 */
export const METADATA_REQUEST_TEXT = '__metadata__';

class UnaryEchoHandler extends Actor<GrpcUnaryCall> {
  override onReceive(call: GrpcUnaryCall): void {
    const request = call.request as { text?: string };
    if (request.text === HANG_REQUEST_TEXT) return;  // never responds — see 05-deadline
    if (request.text === METADATA_REQUEST_TEXT) {    // see 06-metadata
      const names = Object.keys(call.metadata).sort();
      call.respond({ text: names.join(','), sequence: names.length });
      return;
    }
    call.respond({ text: request.text ?? '', sequence: 0 });
  }
}

class ServerStreamHandler extends Actor<GrpcServerStreamCall> {
  override onReceive(call: GrpcServerStreamCall): void {
    const request = call.request as { text?: string; count?: number };
    const count = request.count ?? 3;
    for (let i = 0; i < count; i++) {
      call.send({ text: `${request.text ?? ''}-${i}`, sequence: i });
    }
    call.complete();
  }
}

/**
 * Wrap two callbacks in the `ActorRef` shape `onData` subscribes.
 * `m` is annotated because the `as unknown as` erases the contextual
 * type that would otherwise infer it.
 */
function requestStreamSink(
  onChunk: (m: GrpcChunkMessage) => void,
  onEnd: () => void,
): ActorRef<GrpcRequestStreamInbound> {
  return {
    tell: (m: GrpcRequestStreamInbound): void => {
      match(m)
        .with({ kind: 'chunk' }, (c) => onChunk(c))
        .with({ kind: 'end' }, () => onEnd())
        .exhaustive();
    },
  } as unknown as ActorRef<GrpcRequestStreamInbound>;
}

class ClientStreamHandler extends Actor<GrpcClientStreamCall> {
  override onReceive(call: GrpcClientStreamCall): void {
    // Count the request chunks, answer once when the client closes.
    let count = 0;
    let lastText = '';
    call.onData(requestStreamSink(
      (m) => { lastText = (m.chunk as { text?: string }).text ?? ''; count += 1; },
      () => call.respond({ text: lastText, sequence: count }),
    ));
  }
}

class BidiHandler extends Actor<GrpcBidiCall> {
  override onReceive(call: GrpcBidiCall): void {
    // Echo every chunk back, then complete when the client closes.
    let sequence = 0;
    call.onData(requestStreamSink(
      (m) => call.send({ text: (m.chunk as { text?: string }).text ?? '', sequence: sequence++ }),
      () => call.complete(),
    ));
  }
}

async function main(): Promise<void> {
  const bind = requireEnv('GRPC_BIND');
  const endpoint = requireEnv('GRPC_ENDPOINT');
  const protoPath = requireEnv('GRPC_PROTO_PATH');

  const system = ActorSystem.create('grpc-runner', ActorSystemOptions.create()
    .withLogger(new JsonLogger()).withLogLevel(LogLevel.Info));
  process.on('SIGTERM', () => { void system.terminate(); });

  // Spawn the server-side handlers and the server actor.
  const unaryHandler = system.spawnAnonymous(UnaryEchoHandler);
  const streamHandler = system.spawnAnonymous(ServerStreamHandler);
  const clientStreamHandler = system.spawnAnonymous(ClientStreamHandler);
  const bidiHandler = system.spawnAnonymous(BidiHandler);

  const server = system.spawnAnonymous(
    () => new GrpcServerActor(
      GrpcServerOptions.create()
        .withProtoPath(protoPath)
        .withPackageName('echo.v1')
        .withServiceName('EchoService')
        .withBind(bind)
        .withHandlers({
          Unary: { kind: 'unary', target: unaryHandler as unknown as ActorRef<GrpcUnaryCall> },
          ServerStream: { kind: 'serverStream', target: streamHandler as unknown as ActorRef<GrpcServerStreamCall> },
          ClientStream: {
            kind: 'clientStream',
            target: clientStreamHandler as unknown as ActorRef<GrpcClientStreamCall>,
          },
          Bidi: { kind: 'bidi', target: bidiHandler as unknown as ActorRef<GrpcBidiCall> },
        }),
    ),
  );

  // Give the server a moment to bind.  GrpcServerActor's preStart
  // blocks until the bind succeeds, but the actor's spawn returns
  // before preStart finishes; a short sleep is the simplest gate.
  await new Promise((r) => setTimeout(r, 1_500));

  // Spawn the client actor.
  const client = system.spawnAnonymous(
    () => new GrpcClientActor(
      GrpcClientOptions.create()
        .withProtoPath(protoPath)
        .withPackageName('echo.v1')
        .withServiceName('EchoService')
        .withEndpoint(endpoint)
        .withCredentials({ kind: 'insecure' }),
    ),
  );
  await new Promise((r) => setTimeout(r, 500));

  const context: GrpcContext = {
    env: process.env,
    endpoint,
    system,
    client: client as unknown as ActorRef<unknown>,
  };

  try {
    const scenarios: BrokerScenario<GrpcContext>[] = [
      unaryScenario,
      serverStreamScenario,
      bidiScenario,
      clientStreamScenario,
      deadlineScenario,
      metadataScenario,
    ];
    await runScenarios(scenarios, context);
  } finally {
    client.stop();
    server.stop();
    unaryHandler.stop();
    streamHandler.stop();
    clientStreamHandler.stop();
    bidiHandler.stop();
    await system.terminate();
  }
}

/**
 * Reply-collector actor — receives `GrpcInbound` messages from a
 * client call and records them for the scenario's assertions.
 */
export class CollectorActor extends Actor<GrpcInbound> {
  readonly inbound: GrpcInbound[] = [];
  override onReceive(m: GrpcInbound): void { this.inbound.push(m); }
}

export function spawnCollector(context: GrpcContext): {
  ref: ReturnType<ActorSystem['spawnAnonymous']>; collector: CollectorActor;
} {
  const collector = new CollectorActor();
  const ref = context.system.spawnAnonymous(() => collector);
  return { ref, collector };
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
