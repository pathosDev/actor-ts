/**
 * #997 — `service-requests-done` waits for the HTTP requests in flight.
 *
 * A bind registers two shutdown tasks: `http-unbind-<host>:<port>` in
 * `service-unbind` starts the unbind and returns, so that phase does not hold
 * the pipeline for the drain, and `http-drain-<host>:<port>` in
 * `service-requests-done` awaits it.  Without the second, every later phase —
 * the services' own stop, the cluster leave, the system's termination — ran
 * while a request was still being answered.
 *
 * `tests/smoke/cases/61-http-shutdown-drain.mjs` holds the end-to-end drain on
 * every runtime; this is the bun-test half, which says which phase the wait
 * belongs to.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/** How long the handler works once entered: well inside the default grace period. */
const HANDLER_WORK_MS = 300;

const systems: ActorSystem[] = [];
afterEach(async () => {
  while (systems.length) await systems.pop()!.terminate();
});

describe('the HTTP drain task (#997)', () => {
  test('service-requests-done holds the pipeline until the request in flight has its answer', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-shutdown-drain-task', systemOptions);
    systems.push(system);
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let handlerFinished = false;
    const route = path('slow', get(async () => {
      signalEntered();
      await new Promise<void>((resolve) => setTimeout(resolve, HANDLER_WORK_MS)); // the handler's own work, which the drain must wait for
      handlerFinished = true;
      return completeText(200, 'late but whole');
    }));
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(route);

    const shutdown = system.extension(CoordinatedShutdownId);
    const drainTaskName = `http-drain-${binding.host}:${binding.port}`;
    expect(() => { shutdown.addTask(Phases.ServiceRequestsDone, drainTaskName, () => undefined); })
      .toThrow(/already registered/);

    let handlerFinishedAtServiceStop: boolean | undefined;
    shutdown.addTask(Phases.ServiceStop, 'observe-the-drain', () => { handlerFinishedAtServiceStop = handlerFinished; });

    const response = fetch(`http://127.0.0.1:${binding.port}/slow`);
    await entered;
    await shutdown.run();

    expect(handlerFinishedAtServiceStop).toBe(true);
    const answer = await response;
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('late but whole');
  });
});
