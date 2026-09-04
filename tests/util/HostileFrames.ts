import { NodeAddress } from '../../src/cluster/NodeAddress.js';

/**
 * The two malformed-input corpora the cluster's inbound edges are held to.
 *
 * They exist as one shared module because they were three hand-maintained
 * copies of the same idea and drifted the way copies do: the table in
 * `tests/unit/worker/WorkerBroker.test.ts` and the one in
 * `tests/unit/testkit/MultiNodeBroker.test.ts` already said, in a comment, that
 * they were "deliberately the same table" — while the transport those frames
 * are re-posted *to* had no malformed case at all, which is how #945 stayed
 * open for a month behind two suites that looked like they covered it.
 *
 * A corpus in one place is also the only shape in which #945's last acceptance
 * criterion can be true: "one contract test exercises the same malformed-frame
 * corpus against `TcpTransport`, `InMemoryTransport` and
 * `MessageChannelTransport`" is a statement about *sameness*, and three
 * literals cannot make it.
 */

/**
 * One case: what to call it in the test name, and the value to feed in.
 *
 * `unknown` and not a frame type on purpose — every entry is something a frame
 * type says cannot happen, and typing the table as the shape it violates would
 * need a cast per row.
 */
export type HostileFrame = readonly [label: string, frame: unknown];

const address = (port: number): NodeAddress => new NodeAddress('sys', 'host', port);

/**
 * **Envelope level** — what a worker may put on its `MessagePort`, checked
 * before anything reads `to` or `from`.
 *
 * Every case here used to throw out of a `message` listener: out of the
 * broker's, which is the host thread (#701), or out of the receiving
 * transport's, which is a worker thread (#945).  Neither has a caller to
 * unwind into, so each throw was an uncaught top-level error rather than a
 * dropped frame.
 *
 * Two of them throw a `TypeError` from the `frame.to` dereference itself; the
 * rest throw a plain `Error` from the hardened `fromJSON` (#571), so a test
 * written against `TypeError` alone would miss half of them.
 */
export const hostileEnvelopes: ReadonlyArray<HostileFrame> = [
  ['undefined', undefined],
  ['null', null],
  ['a bare string', 'not-an-envelope'],
  ['no `to` at all', { from: address(1).toJSON(), payload: { kind: 'ping' } }],
  ['`to` null', { from: address(1).toJSON(), to: null, payload: { kind: 'ping' } }],
  // The regression #571 introduced: before `fromJSON` validated, this
  // constructed an address and was routed or dropped as unknown — never fatal.
  ['`to.port` a string', {
    from: address(1).toJSON(),
    to: { systemName: 'sys', host: 'host', port: '2' },
    payload: { kind: 'ping' },
  }],
  // `from` is what a broker's `withChannelSource` reads before the frame is
  // re-posted, and what the receiving `MessageChannelTransport` dereferences
  // after, so it is checked here too.
  ['`from` missing', { to: address(2).toJSON(), payload: { kind: 'ping' } }],
  ['`from` null', { from: null, to: address(2).toJSON(), payload: { kind: 'ping' } }],
];

/**
 * **Payload level** — what `validateWireFrame` refuses, which is the corpus
 * every `Transport` implementation owes the same answer to.
 *
 * All of it is JSON-representable, deliberately: the `TcpTransport` arm of the
 * contract test has to put each case through `encodeFrame`, so a value
 * `JSON.stringify` cannot express would exclude that transport from the very
 * comparison the corpus exists to make.  The envelope corpus above is where
 * `undefined` belongs — it never survives a wire encode, only a `postMessage`.
 *
 * The gossip entry is #563's frame verbatim.  It is the case that makes the
 * missing call site more than a robustness bug: the other two transports
 * refuse it, so a poisoned `status` reaching `Cluster.mergeMember` was a route
 * that existed on the multi-core path alone.
 */
export const hostileWirePayloads: ReadonlyArray<HostileFrame> = [
  ['null', null],
  ['a bare string', 'hello'],
  ['a number', 42],
  ['an array', []],
  ['no `kind`', { self: address(2).toJSON() }],
  ['a non-string `kind`', { kind: 42 }],
  ['`hello` without `self`', { kind: 'hello' }],
  ['`heartbeat` with a null `from`', { kind: 'heartbeat', from: null, seq: 1, ts: 0 }],
  ['`heartbeat` with a non-numeric `seq`', {
    kind: 'heartbeat', from: address(2).toJSON(), seq: 'soon', ts: 0,
  }],
  ['`gossip` with a member status outside the legal set (#563)', {
    kind: 'gossip',
    from: address(2).toJSON(),
    sequence: 1,
    members: [{ address: address(3).toJSON(), status: 'pwned', version: 1 }],
  }],
  ['`gossip` whose `members` is not an array', {
    kind: 'gossip', from: address(2).toJSON(), sequence: 1, members: 'all of them',
  }],
  ['`envelope` without a `to` path', { kind: 'envelope', to: null, from: null }],
  ['`leave` whose `node.port` is a string', {
    kind: 'leave', node: { systemName: 'sys', host: 'host', port: '3' },
  }],
];
