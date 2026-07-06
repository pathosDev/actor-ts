/**
 * gRPC live-integration runner (B.8 / Closes #296).
 *
 * Spawns a GrpcServerActor + a GrpcClientActor in the same
 * ActorSystem, both pointed at the same `echo.proto`.  Each
 * scenario exercises one call class.
 */
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { JsonLogger, LogLevel } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { GrpcClientActor, type GrpcInbound } from '../../../../src/io/broker/GrpcClientActor.js';
import { GrpcClientOptions } from '../../../../src/io/broker/GrpcClientOptions.js';
import {
  GrpcServerActor,
  type GrpcUnaryCall,
  type GrpcServerStreamCall,
  type GrpcBidiCall,
} from '../../../../src/io/broker/GrpcServerActor.js';
import { GrpcServerOptions } from '../../../../src/io/broker/GrpcServerOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as unaryScenario } from './scenarios/01-unary.js';
import { scenario as serverStreamScenario } from './scenarios/02-server-stream.js';
import { scenario as bidiScenario } from './scenarios/03-bidi.js';

export interface GrpcCtx extends BrokerScenarioCtx {
  readonly endpoint: string;
  readonly system: ActorSystem;
  readonly client: ActorRef<unknown>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`runner: missing env var ${name}`);
  return v;
}

/* --------------------------- Server-side handlers ----------------------- */

class UnaryEchoHandler extends Actor<GrpcUnaryCall> {
  override onReceive(call: GrpcUnaryCall): void {
    const req = call.request as { text?: string };
    call.respond({ text: req.text ?? '', sequence: 0 });
  }
}

class ServerStreamHandler extends Actor<GrpcServerStreamCall> {
  override onReceive(call: GrpcServerStreamCall): void {
    const req = call.request as { text?: string; count?: number };
    const n = req.count ?? 3;
    for (let i = 0; i < n; i++) {
      call.send({ text: `${req.text ?? ''}-${i}`, sequence: i });
    }
    call.complete();
  }
}

class BidiHandler extends Actor<GrpcBidiCall> {
  override onReceive(call: GrpcBidiCall): void {
    // Echo every chunk back, then complete when the client closes.
    let seq = 0;
    const sink: ActorRef<{ kind: 'chunk'; chunk: unknown } | { kind: 'end' }> = {
      tell: (m): void => {
        if (m.kind === 'chunk') {
          const c = m.chunk as { text?: string };
          call.send({ text: c.text ?? '', sequence: seq++ });
        } else if (m.kind === 'end') {
          call.complete();
        }
      },
    } as unknown as ActorRef<{ kind: 'chunk'; chunk: unknown } | { kind: 'end' }>;
    call.onData(sink);
  }
}

async function main(): Promise<void> {
  const bind = requireEnv('GRPC_BIND');
  const endpoint = requireEnv('GRPC_ENDPOINT');
  const protoPath = requireEnv('GRPC_PROTO_PATH');

  const system = ActorSystem.create('grpc-runner', {
    logger: new JsonLogger(), logLevel: LogLevel.Info,
  });
  process.on('SIGTERM', () => { void system.terminate(); });

  // Spawn the server-side handlers and the server actor.
  const unaryHandler = system.spawnAnonymous(Props.create(() => new UnaryEchoHandler()));
  const streamHandler = system.spawnAnonymous(Props.create(() => new ServerStreamHandler()));
  const bidiHandler = system.spawnAnonymous(Props.create(() => new BidiHandler()));

  const server = system.spawnAnonymous(
    Props.create(() => new GrpcServerActor(
      GrpcServerOptions.create()
        .withProtoPath(protoPath)
        .withPackageName('echo.v1')
        .withServiceName('EchoService')
        .withBind(bind)
        .withHandlers({
          Unary: { kind: 'unary', target: unaryHandler as unknown as ActorRef<GrpcUnaryCall> },
          ServerStream: { kind: 'serverStream', target: streamHandler as unknown as ActorRef<GrpcServerStreamCall> },
          Bidi: { kind: 'bidi', target: bidiHandler as unknown as ActorRef<GrpcBidiCall> },
        }),
    )),
  );

  // Give the server a moment to bind.  GrpcServerActor's preStart
  // blocks until the bind succeeds, but the actor's spawn returns
  // before preStart finishes; a short sleep is the simplest gate.
  await new Promise((r) => setTimeout(r, 1_500));

  // Spawn the client actor.
  const client = system.spawnAnonymous(
    Props.create(() => new GrpcClientActor(
      GrpcClientOptions.create()
        .withProtoPath(protoPath)
        .withPackageName('echo.v1')
        .withServiceName('EchoService')
        .withEndpoint(endpoint)
        .withCredentials({ kind: 'insecure' }),
    )),
  );
  await new Promise((r) => setTimeout(r, 500));

  const ctx: GrpcCtx = {
    env: process.env,
    endpoint,
    system,
    client: client as unknown as ActorRef<unknown>,
  };

  try {
    const scenarios: BrokerScenario<GrpcCtx>[] = [
      unaryScenario,
      serverStreamScenario,
      bidiScenario,
    ];
    await runScenarios(scenarios, ctx);
  } finally {
    client.stop();
    server.stop();
    unaryHandler.stop();
    streamHandler.stop();
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

export function spawnCollector(ctx: GrpcCtx): {
  ref: ReturnType<ActorSystem['spawnAnonymous']>; collector: CollectorActor;
} {
  const collector = new CollectorActor();
  const ref = ctx.system.spawnAnonymous(Props.create(() => collector));
  return { ref, collector };
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
