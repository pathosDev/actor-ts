/**
 * #1487 — a malformed `actor-ts.http.request-timeout.deadline` fails every
 * `bind()`, on every backend, whether or not a `requestTimeout()` is in the
 * route tree.
 *
 * `HttpExtension.bind` reads the configured deadline for every server — it is
 * the floor of the request deadline handed to the backend, and the Hono backend
 * under Bun derives its idle timeout from it — so it validates it there too,
 * exactly as the middleware validates its own.  Before, a tree with no
 * `requestTimeout()` never read the block, and a deadline of `0ms` bound
 * without a word on Fastify and Express alike.  Swallowing the refusal in that
 * read would bring that back, so each backend is pinned with a tree that holds
 * no `requestTimeout()` at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Config } from '../../../../src/config/Config.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import { complete, get } from '../../../../src/http/Route.js';
import { Status } from '../../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const systems: ActorSystem[] = [];
afterEach(async () => {
  while (systems.length) await systems.pop()!.terminate();
});

/** What `bind()` did under `hocon`: the refusal it threw, or `undefined` once it bound (and was unbound again). */
async function bindOutcome(hocon: string): Promise<unknown> {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create('malformed-request-deadline', options);
  systems.push(system);
  try {
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(get(() => complete(Status.OK, 'ok')));
    await binding.unbind();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('a malformed actor-ts.http.request-timeout.deadline fails bind() with no requestTimeout() in the tree (#1487)', () => {
  for (const backend of ['fastify', 'express', 'hono'] as const) {
    // Not positive, below zero, and longer than a timer can hold.
    for (const deadline of ['0ms', '-3s', '30d'] as const) {
      test(`${backend}, deadline = ${deadline}`, async () => {
        const refusal = await bindOutcome(`actor-ts.http { backend = ${backend}, request-timeout { deadline = ${deadline} } }`);

        expect(refusal).toBeInstanceOf(OptionsError);
        expect((refusal as OptionsError).options).toBe('TimeoutOptions');
        expect((refusal as OptionsError).field).toBe('deadlineMs');
      });
    }

    test(`${backend}, a well-formed deadline binds`, async () => {
      expect(await bindOutcome(`actor-ts.http { backend = ${backend}, request-timeout { deadline = 10s } }`)).toBeUndefined();
    });
  }
});
