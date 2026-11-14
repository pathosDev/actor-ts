/**
 * #1813 — a frame a node sends to itself comes back to its own handler.
 *
 * `ClusterRouter` turns every candidate member into a `RemoteActorRef`, its
 * own node included, and a `RemoteActorRef` may name the local node anyway.
 * The in-memory and worker-mesh transports loop such a frame back; the TCP
 * transport dialled its own listener instead, whose handshake refuses a peer
 * claiming the node's own address, so every frame to the node itself was lost.
 *
 * The loopback leg must behave like a hop, not like a shortcut: the frame is
 * encoded and decoded (so a message that would not survive the wire does not
 * survive here either), shape-checked like an inbound frame, and handed over
 * on a microtask, never inside the `send` that wrote it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const self = new NodeAddress('sim', '10.0.0.100', 5_000, 'test-run');

/** The private seam a dial goes through — counted, so a dial to itself shows. */
interface TransportInternals {
  backend: unknown;
}

type Delivery = { readonly from: string; readonly message: WireMessage };

const transports: TcpTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.shutdown();
});

function startTransport(): { transport: TcpTransport; log: RecordingLogger; dials: string[]; delivered: Delivery[] } {
  const log = new RecordingLogger();
  const transport = new TcpTransport(self, log);
  transports.push(transport);
  const dials: string[] = [];
  (transport as unknown as TransportInternals).backend = {
    listen: () => Promise.resolve({ port: 0, close: () => {} }),
    connect: (options: { host: string; port: number }) => {
      dials.push(`${options.host}:${options.port}`);
      return new Promise(() => {});
    },
  };
  const delivered: Delivery[] = [];
  transport.setHandler((from, message) => { delivered.push({ from: from.toString(), message }); });
  return { transport, log, dials, delivered };
}

function envelope(payload: unknown): WireMessage {
  return { kind: 'envelope', to: '/user/sink', from: null, payload } as unknown as WireMessage;
}

/** Let the microtask queue run dry, and one macrotask besides. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('TcpTransport delivers a frame addressed to its own node (#1813)', () => {
  test('the frame reaches the handler, from the node itself, without a dial', async () => {
    const { transport, dials, delivered } = startTransport();

    transport.send(self, envelope({ n: 1 }));
    transport.send(self, envelope({ n: 2 }));
    await settle();

    expect(delivered.map((delivery) => delivery.from)).toEqual([self.toString(), self.toString()]);
    expect(delivered.map((delivery) => (delivery.message as unknown as { payload: unknown }).payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(dials).toEqual([]);
    expect(transport.peers()).toEqual([]);
  });

  test('an address equal to the node\'s own, built separately, is the node itself', async () => {
    const { transport, dials, delivered } = startTransport();

    transport.send(new NodeAddress('sim', '10.0.0.100', 5_000, 'test-run'), envelope('x'));
    await settle();

    expect(delivered).toHaveLength(1);
    expect(dials).toEqual([]);
  });

  test('the handler runs after send returns, not inside it', async () => {
    const { transport, delivered } = startTransport();

    transport.send(self, envelope('later'));

    expect(delivered).toEqual([]);
    await settle();
    expect(delivered).toHaveLength(1);
  });

  test('what arrives is a decoded copy, not the object that was sent', async () => {
    const { transport, delivered } = startTransport();
    const payload = { when: new Date(0), tags: new Set(['a']) };

    transport.send(self, envelope(payload));
    payload.tags.add('mutated after send');
    await settle();

    const arrived = (delivered[0]!.message as unknown as { payload: typeof payload }).payload;
    expect(arrived).not.toBe(payload);
    expect(arrived.when).toEqual(new Date(0));
    expect([...arrived.tags]).toEqual(['a']);
  });

  test('a payload the wire codec refuses is dropped and logged, not thrown', async () => {
    const { transport, log, delivered } = startTransport();

    expect(() => transport.send(self, envelope({ callback: () => 1 }))).not.toThrow();
    await settle();

    expect(delivered).toEqual([]);
    expect(log.records.filter((record) => record.level === 'error' && record.message.startsWith("dropping a 'envelope' frame")))
      .toHaveLength(1);
  });

  test('a frame that fails the shape check is dropped like an inbound one', async () => {
    const { transport, log, delivered } = startTransport();

    transport.send(self, { kind: 'gossip' } as unknown as WireMessage);
    await settle();

    expect(delivered).toEqual([]);
    expect(log.records.some((record) => record.level === 'warn' && record.message.startsWith('rejecting malformed frame'))).toBe(true);
  });

  test('a handshake frame addressed to the node itself is not handed to the handler', async () => {
    const { transport, delivered } = startTransport();

    transport.send(self, { kind: 'hello', self: self.toJSON(), wireVersion: 2, minWireVersion: 2 } as WireMessage);
    transport.send(self, { kind: 'hello-ack', self: self.toJSON(), wireVersion: 2 } as WireMessage);
    await settle();

    expect(delivered).toEqual([]);
  });

  test('a handler that throws is contained and logged', async () => {
    const { transport, log } = startTransport();
    transport.setHandler(() => { throw new Error('handler failed'); });

    transport.send(self, envelope('boom'));
    await settle();

    expect(log.records.some((record) => record.level === 'warn' && record.message.startsWith('wire handler threw on a frame from'))).toBe(true);
  });

  test('a stopped transport delivers nothing to itself', async () => {
    const { transport, delivered } = startTransport();

    transport.send(self, envelope('queued'));
    await transport.shutdown();
    transport.send(self, envelope('after stop'));
    await settle();

    expect(delivered).toEqual([]);
  });
});
