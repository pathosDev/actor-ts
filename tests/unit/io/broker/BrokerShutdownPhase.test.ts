import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { Config } from '../../../../src/config/Config.js';
import {
  CoordinatedShutdownId,
  Phases,
  UnknownReason,
} from '../../../../src/CoordinatedShutdown.js';
import { BrokerActor } from '../../../../src/io/broker/BrokerActor.js';
import type { BrokerCommonOptionsType } from '../../../../src/io/broker/BrokerOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/**
 * Broker teardown belongs in `service-stop`, not at the very end (#549).
 *
 * `postStop` has always closed the transport, and the `/user` stop cascade
 * that `actor-system-terminate` triggers has always reached it — so the
 * defect was never "brokers are not torn down".  It was that they were torn
 * down *last*: a broker kept publishing while the HTTP server was unbinding
 * and while the node was leaving the cluster, which is how a message gets
 * emitted by a node its peers have already written off.
 */

interface RecordingOptions extends BrokerCommonOptionsType {
  readonly endpoint?: string;
}

/** The broker under test never receives anything; the union exists to type it. */
type NoopMessage = { readonly kind: 'noop' };

class RecordingBroker extends BrokerActor<RecordingOptions, NoopMessage, string, string> {
  static disconnects: string[] = [];

  constructor(options: Partial<RecordingOptions> = {}) { super(options); }

  protected configKey(): string { return 'actor-ts.io.broker.recording'; }
  protected builtInDefaultOptions(): Partial<RecordingOptions> { return { endpoint: 'fake://x' }; }
  protected readOptionsFromConfig(_config: Config): Partial<RecordingOptions> { return {}; }
  protected requiredOptions(): ReadonlyArray<keyof RecordingOptions> { return ['endpoint']; }
  protected endpointLabel(): string { return this.options.endpoint ?? '<none>'; }

  protected async connectImplementation(): Promise<void> { /* nothing to open */ }
  protected async disconnectImplementation(): Promise<void> {
    RecordingBroker.disconnects.push(this.self.path.toString());
  }
  protected async dispatchOutgoing(): Promise<void> { /* never sends */ }
  protected onCommand(): void { /* never receives */ }
}

const newSystem = (name: string, autoRegisterTasks = true): ActorSystem => {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({
      'actor-ts': { 'coordinated-shutdown': { 'auto-register-tasks': autoRegisterTasks } },
    });
  return ActorSystem.create(name, systemOptions);
};

const serviceStopTaskNames = (system: ActorSystem): string[] => {
  const registry = system.extension(CoordinatedShutdownId) as unknown as {
    tasks: Map<string, ReadonlyArray<{ name: string }>>;
  };
  return (registry.tasks.get(Phases.ServiceStop) ?? []).map((task) => task.name);
};

describe('broker teardown runs in service-stop', () => {
  test('a started broker registers one task, named after its path', async () => {
    RecordingBroker.disconnects = [];
    const system = newSystem('broker-registers');
    const broker = system.spawn(RecordingBroker, 'orders');
    await awaitCondition(() => serviceStopTaskNames(system).length === 1);

    expect(serviceStopTaskNames(system)).toEqual([`broker-stop-${broker.path.toString()}`]);

    await system.terminate();
  });

  test('the pipeline closes the connection before the cluster phases', async () => {
    RecordingBroker.disconnects = [];
    const system = newSystem('broker-ordering');
    system.spawn(RecordingBroker, 'orders');
    await awaitCondition(() => serviceStopTaskNames(system).length === 1);

    const seenAtClusterLeave: string[][] = [];
    system.extension(CoordinatedShutdownId).addTask(
      Phases.ClusterLeave,
      'observe',
      () => { seenAtClusterLeave.push([...RecordingBroker.disconnects]); },
    );

    await system.extension(CoordinatedShutdownId).run(UnknownReason.instance);

    // Closed by the time membership is given up — the ordering the phase
    // list promises and that last-phase teardown could not deliver.
    expect(seenAtClusterLeave).toHaveLength(1);
    expect(seenAtClusterLeave[0]).toHaveLength(1);
    // And exactly once: the `postStop` that follows finds the transport
    // already closed and does nothing.
    expect(RecordingBroker.disconnects).toHaveLength(1);
  });

  test('stopping the actor takes its task with it', async () => {
    RecordingBroker.disconnects = [];
    const system = newSystem('broker-unregisters');
    const broker = system.spawn(RecordingBroker, 'orders');
    await awaitCondition(() => serviceStopTaskNames(system).length === 1);

    broker.stop();
    await awaitCondition(() => serviceStopTaskNames(system).length === 0);

    // A same-named broker can take the slot again — which is what a restart
    // under supervision does.
    system.spawn(RecordingBroker, 'orders-2');
    await awaitCondition(() => serviceStopTaskNames(system).length === 1);

    await system.terminate();
  });

  test('auto-register-tasks = false keeps the phase empty', async () => {
    RecordingBroker.disconnects = [];
    const system = newSystem('broker-opt-out', false);
    system.spawn(RecordingBroker, 'orders');

    // Terminating proves the broker really did start — `disconnects` only
    // grows for a transport that was opened — while the phase stayed empty.
    await system.terminate();

    expect(serviceStopTaskNames(system)).toEqual([]);
    // Still torn down, just by `postStop` in the terminate cascade: opting
    // out gives up the *ordering*, never the teardown.
    expect(RecordingBroker.disconnects).toHaveLength(1);
  });
});
