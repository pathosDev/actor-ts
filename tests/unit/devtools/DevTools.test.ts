import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DevTools } from '../../../src/devtools/DevTools.js';
import { DevToolsOptions } from '../../../src/devtools/DevToolsOptions.js';
import { devtoolsOf } from '../../../src/devtools/DevToolsExtension.js';
import {
  DEVTOOLS_CLOSE_VERSION_MISMATCH,
  DEVTOOLS_PROTOCOL_VERSION,
  helloFrame,
  type DevToolsServerFrame,
} from '../../../src/devtools/protocol/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) {
    await DevTools.detach(system);
    await system.terminate();
  }
});

function newSystem(name = 'devtools-test'): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/** Attach on an ephemeral port so parallel test files never collide. */
function attach(system: ActorSystem, extra: Record<string, unknown> = {}) {
  return DevTools.attach(system, { port: 0, host: '127.0.0.1', ...extra });
}

/** Open the tap, run the exchange, and always close the socket. */
async function withSocket<T>(
  url: string,
  exchange: (socket: WebSocket, next: () => Promise<DevToolsServerFrame>) => Promise<T>,
): Promise<T> {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/api/ws`);
  const inbox: DevToolsServerFrame[] = [];
  const waiters: ((frame: DevToolsServerFrame) => void)[] = [];
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as DevToolsServerFrame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else inbox.push(frame);
  });
  const next = (): Promise<DevToolsServerFrame> => {
    const buffered = inbox.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise<DevToolsServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a DevTools frame')), 5000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  };

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('websocket failed to open')));
  });
  try {
    return await exchange(socket, next);
  } finally {
    socket.close();
  }
}

describe('DevTools.attach', () => {
  test('binds a loopback server and reports its URL', async () => {
    const system = newSystem();
    const devtools = await attach(system);
    expect(devtools.host).toBe('127.0.0.1');
    expect(devtools.port).toBeGreaterThan(0);
    expect(devtools.url).toBe(`http://127.0.0.1:${devtools.port}`);
  });

  test('serves the embedded UI shell', async () => {
    const system = newSystem();
    const devtools = await attach(system);
    const response = await fetch(`${devtools.url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('id="app"');
  });

  test('exposes the handshake as plain JSON for curl', async () => {
    const system = newSystem('info-system');
    const devtools = await attach(system);
    const info = await (await fetch(`${devtools.url}/api/info`)).json() as {
      protocolVersion: number;
      systemName: string;
      panels: { id: string; status: string }[];
    };
    expect(info.protocolVersion).toBe(DEVTOOLS_PROTOCOL_VERSION);
    expect(info.systemName).toBe('info-system');
    expect(info.panels.find((panel) => panel.id === 'dashboard')?.status).toBe('active');
  });

  test('reports a panel the operator switched off as disabled', async () => {
    const system = newSystem();
    const devtools = await attach(system, { panels: { timeTravel: false } });
    const info = await (await fetch(`${devtools.url}/api/info`)).json() as {
      panels: { id: string; status: string; reason?: string }[];
    };
    const timeTravel = info.panels.find((panel) => panel.id === 'time-travel');
    expect(timeTravel?.status).toBe('disabled');
    expect(timeTravel?.reason).toContain('switched off');
  });

  test('can run headless, with the tap but no UI', async () => {
    const system = newSystem();
    const devtools = await attach(system, { serveUi: false });
    expect((await fetch(`${devtools.url}/`)).status).toBe(404);
    expect((await fetch(`${devtools.url}/api/info`)).status).toBe(200);
  });

  test('refuses a routable bind with no gate in front of it', async () => {
    const system = newSystem();
    await expect(DevTools.attach(system, { host: '0.0.0.0', port: 0 })).rejects.toThrow(OptionsError);
  });

  test('attaching twice returns the same binding instead of failing', async () => {
    const system = newSystem();
    const first = await attach(system);
    const second = await DevTools.attach(system, { port: 0 });
    expect(second.port).toBe(first.port);
  });

  test('terminating the system releases the port', async () => {
    // `system.terminate()` does not run CoordinatedShutdown, so without
    // an explicit lifetime link the DevTools server would stay bound and
    // keep the process alive after the system it debugs is gone.
    const system = newSystem();
    const devtools = await attach(system);
    const url = devtools.url;
    await system.terminate();
    // The unbind is kicked off from `whenTerminated`, so give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(devtoolsOf(system).isAttached()).toBe(false);
    await expect(fetch(`${url}/api/info`)).rejects.toThrow();
  });

  test('detach releases the port', async () => {
    const system = newSystem();
    const devtools = await attach(system);
    const url = devtools.url;
    await devtools.detach();
    expect(devtoolsOf(system).isAttached()).toBe(false);
    await expect(fetch(`${url}/api/info`)).rejects.toThrow();
  });
});

describe('DevTools tap handshake', () => {
  test('answers hello with a welcome describing the system', async () => {
    const system = newSystem('handshake-system');
    const devtools = await attach(system);
    const welcome = await withSocket(devtools.url, async (socket, next) => {
      socket.send(JSON.stringify(helloFrame('test-client')));
      return next();
    });
    expect(welcome.kind).toBe('welcome');
    if (welcome.kind !== 'welcome') throw new Error('expected a welcome frame');
    expect(welcome.protocolVersion).toBe(DEVTOOLS_PROTOCOL_VERSION);
    expect(welcome.systemName).toBe('handshake-system');
    expect(welcome.panels.some((panel) => panel.id === 'dashboard')).toBe(true);
  });

  test('rejects and closes a client speaking a different protocol version', async () => {
    const system = newSystem();
    const devtools = await attach(system);
    const { frame, closeCode } = await withSocket(devtools.url, async (socket, next) => {
      const closed = new Promise<number>((resolve) => {
        socket.addEventListener('close', (event) => resolve(event.code));
      });
      socket.send(JSON.stringify({ kind: 'hello', protocolVersion: 999 }));
      const received = await next();
      return { frame: received, closeCode: await closed };
    });
    expect(frame.kind).toBe('error');
    if (frame.kind !== 'error') throw new Error('expected an error frame');
    expect(frame.code).toBe('version-mismatch');
    expect(closeCode).toBe(DEVTOOLS_CLOSE_VERSION_MISMATCH);
  });

  test('rejects a frame that is not part of the protocol', async () => {
    const system = newSystem();
    const devtools = await attach(system);
    const frame = await withSocket(devtools.url, async (socket, next) => {
      socket.send(JSON.stringify({ kind: 'drop-everything' }));
      return next();
    });
    expect(frame.kind).toBe('error');
    if (frame.kind !== 'error') throw new Error('expected an error frame');
    expect(frame.code).toBe('malformed-frame');
  });

  test('requires the handshake before anything else', async () => {
    const system = newSystem();
    const devtools = await attach(system);
    const frame = await withSocket(devtools.url, async (socket, next) => {
      socket.send(JSON.stringify({ kind: 'subscribe', stream: 'actors' }));
      return next();
    });
    expect(frame.kind).toBe('error');
    if (frame.kind !== 'error') throw new Error('expected an error frame');
    expect(frame.message).toContain('hello');
  });

  test('reports a stream with no tap behind it as unavailable', async () => {
    // A panel the operator switched off registers no tap, so asking for
    // its stream must fail rather than hang.  (Every stream is
    // implemented now, so a disabled panel is the honest way to produce
    // one with nothing behind it.)
    const system = newSystem();
    const devtools = await attach(system, { panels: { profiler: false } });
    const frame = await withSocket(devtools.url, async (socket, next) => {
      socket.send(JSON.stringify(helloFrame()));
      await next();
      socket.send(JSON.stringify({ kind: 'subscribe', stream: 'profiler' }));
      return next();
    });
    expect(frame.kind).toBe('error');
    if (frame.kind !== 'error') throw new Error('expected an error frame');
    expect(frame.code).toBe('unavailable');
  });

  test('reports a method with no handler behind it, keeping the request id', async () => {
    // Same reasoning as the stream case: a disabled panel never
    // registers its methods, so its data cannot leave the process
    // whatever a client asks for.
    const system = newSystem();
    const devtools = await attach(system, { panels: { profiler: false } });
    const frame = await withSocket(devtools.url, async (socket, next) => {
      socket.send(JSON.stringify(helloFrame()));
      await next();
      socket.send(JSON.stringify({ kind: 'request', requestId: 42, method: 'profiler.start' }));
      return next();
    });
    expect(frame.kind).toBe('error');
    if (frame.kind !== 'error') throw new Error('expected an error frame');
    expect(frame.code).toBe('unavailable');
    expect(frame.requestId).toBe(42);
  });
});

describe('DevTools.mount', () => {
  test('produces routes an existing server can host under a prefix', async () => {
    const system = newSystem('mounted-system');
    const devtoolsOptions = DevToolsOptions.create().withServeUi(false);
    const routes = DevTools.mount(system, devtoolsOptions);
    const { path } = await import('../../../src/http/Route.js');
    const { HttpExtensionId } = await import('../../../src/http/HttpExtension.js');
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(path('devtools', routes));
    try {
      const info = await (await fetch(`http://127.0.0.1:${binding.port}/devtools/api/info`)).json() as {
        systemName: string;
      };
      expect(info.systemName).toBe('mounted-system');
    } finally {
      await binding.unbind();
    }
  });
});

describe('DevTools.attach — a failed bind leaves nothing behind', () => {
  test('the port conflict is thrown, and the next attach succeeds', async () => {
    const occupier = newSystem('devtools-occupier');
    const taken = await DevTools.attach(occupier, DevToolsOptions.create().withPort(0));

    const system = newSystem('devtools-retry');
    // Same port, already held by the other system's DevTools.
    await expect(DevTools.attach(system, DevToolsOptions.create().withPort(taken.port)))
      .rejects.toThrow();
    // The failed attempt must not count as an attachment, or the retry
    // below would be handed back a binding whose port never opened.
    expect(devtoolsOf(system).isAttached()).toBe(false);

    await taken.detach();

    // Retrying used to fail on our own leftovers — a CoordinatedShutdown
    // task and an HTTP task both named after something that no longer
    // existed — rather than on anything to do with the port.
    const second = await DevTools.attach(system, DevToolsOptions.create().withPort(0));
    expect(second.port).toBeGreaterThan(0);
    expect(devtoolsOf(system).isAttached()).toBe(true);
    await second.detach();
  });

  test('attach / detach / attach on one system', async () => {
    const system = newSystem('devtools-cycle');
    const first = await DevTools.attach(system, DevToolsOptions.create().withPort(0));
    await first.detach();
    const second = await DevTools.attach(system, DevToolsOptions.create().withPort(0));
    expect(devtoolsOf(system).isAttached()).toBe(true);
    await second.detach();
  });
});
