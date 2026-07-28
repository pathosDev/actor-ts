import { describe, expect, test } from 'bun:test';
import {
  DEVTOOLS_PROTOCOL_VERSION,
  DEVTOOLS_REQUEST_METHODS,
  DEVTOOLS_STREAM_IDS,
  decodeClientFrame,
  errorFrame,
  eventFrame,
  helloFrame,
  isRequestMethod,
  isStreamId,
  responseFrame,
  welcomeFrame,
} from '../../../src/devtools/protocol/index.js';
import { statsSamplePayload } from '../../../src/devtools/protocol/StatsFrames.js';
import { actorTreeSnapshotPayload } from '../../../src/devtools/protocol/ActorStreamFrames.js';
import { clusterEventPayload } from '../../../src/devtools/protocol/ClusterStreamFrames.js';

describe('DevTools protocol — handshake', () => {
  test('helloFrame carries the compiled-in protocol version', () => {
    expect(helloFrame()).toEqual({ kind: 'hello', protocolVersion: DEVTOOLS_PROTOCOL_VERSION });
  });

  test('helloFrame omits `client` rather than sending undefined', () => {
    // JSON.stringify drops undefined properties, so a round-trip must
    // not reintroduce a key the sender never set.
    expect(Object.keys(helloFrame())).toEqual(['kind', 'protocolVersion']);
    expect(helloFrame('devtools-ui').client).toBe('devtools-ui');
  });

  test('welcomeFrame stamps the version so the client need not trust the UI bundle', () => {
    const frame = welcomeFrame({
      serverVersion: '0.11.0',
      systemName: 'test-system',
      startedAtMs: 1000,
      streams: ['stats', 'actors'],
      panels: [{ id: 'dashboard', status: 'active' }],
    });
    expect(frame.kind).toBe('welcome');
    expect(frame.protocolVersion).toBe(DEVTOOLS_PROTOCOL_VERSION);
    expect(frame.systemName).toBe('test-system');
  });
});

describe('DevTools protocol — decodeClientFrame', () => {
  test('accepts every well-formed client frame', () => {
    expect(decodeClientFrame({ kind: 'hello', protocolVersion: 1 })).not.toBeNull();
    expect(decodeClientFrame({ kind: 'subscribe', stream: 'actors' })).not.toBeNull();
    expect(decodeClientFrame({ kind: 'unsubscribe', stream: 'spans' })).not.toBeNull();
    expect(
      decodeClientFrame({ kind: 'request', requestId: 7, method: 'journal.ids' }),
    ).not.toBeNull();
  });

  test('preserves optional parameters', () => {
    const frame = decodeClientFrame({
      kind: 'request',
      requestId: 1,
      method: 'explain.enable',
      parameters: { path: '/user/a', capacity: 32 },
    });
    expect(frame).not.toBeNull();
    expect(frame!.kind).toBe('request');
    expect((frame as { parameters: unknown }).parameters).toEqual({ path: '/user/a', capacity: 32 });
  });

  test('rejects non-objects', () => {
    for (const raw of [null, undefined, 42, 'hello', true, [1, 2]]) {
      expect(decodeClientFrame(raw)).toBeNull();
    }
  });

  test('rejects unknown frame kinds — the server never guesses', () => {
    expect(decodeClientFrame({ kind: 'evict-everything' })).toBeNull();
    expect(decodeClientFrame({})).toBeNull();
  });

  test('rejects unknown stream ids', () => {
    expect(decodeClientFrame({ kind: 'subscribe', stream: 'secrets' })).toBeNull();
    expect(decodeClientFrame({ kind: 'subscribe' })).toBeNull();
    expect(decodeClientFrame({ kind: 'unsubscribe', stream: 7 })).toBeNull();
  });

  test('rejects unknown request methods and non-integer request ids', () => {
    expect(decodeClientFrame({ kind: 'request', requestId: 1, method: 'journal.drop' })).toBeNull();
    expect(decodeClientFrame({ kind: 'request', requestId: 1.5, method: 'journal.ids' })).toBeNull();
    expect(decodeClientFrame({ kind: 'request', method: 'journal.ids' })).toBeNull();
  });

  test('rejects a hello without a numeric version', () => {
    expect(decodeClientFrame({ kind: 'hello' })).toBeNull();
    expect(decodeClientFrame({ kind: 'hello', protocolVersion: '1' })).toBeNull();
    expect(decodeClientFrame({ kind: 'hello', protocolVersion: 1, client: 3 })).toBeNull();
  });

  test('survives a JSON round-trip of every frame it accepts', () => {
    const frames = [
      { kind: 'hello', protocolVersion: DEVTOOLS_PROTOCOL_VERSION, client: 'ui' },
      { kind: 'subscribe', stream: 'stats' },
      { kind: 'unsubscribe', stream: 'stats' },
      { kind: 'request', requestId: 3, method: 'replay.state', parameters: { persistenceId: 'a' } },
    ];
    for (const frame of frames) {
      expect(decodeClientFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame as never);
    }
  });
});

describe('DevTools protocol — vocabulary guards', () => {
  test('isStreamId accepts exactly the declared ids', () => {
    for (const id of DEVTOOLS_STREAM_IDS) expect(isStreamId(id)).toBe(true);
    expect(isStreamId('nope')).toBe(false);
    expect(isStreamId(undefined)).toBe(false);
  });

  test('isRequestMethod accepts exactly the declared methods', () => {
    for (const method of DEVTOOLS_REQUEST_METHODS) expect(isRequestMethod(method)).toBe(true);
    expect(isRequestMethod('journal')).toBe(false);
  });

  test('every declared method is namespaced by its owning panel', () => {
    for (const method of DEVTOOLS_REQUEST_METHODS) {
      expect(method).toMatch(/^(explain|journal|replay|profiler|tracing)\.[a-z]+$/);
    }
  });
});

describe('DevTools protocol — server frames', () => {
  test('event frames carry a per-stream sequence number for gap detection', () => {
    const frame = eventFrame('actors', 12, actorTreeSnapshotPayload(500, []));
    expect(frame).toEqual({
      kind: 'event',
      stream: 'actors',
      sequenceNumber: 12,
      payload: { kind: 'actor-tree-snapshot', atMs: 500, actors: [] },
    });
  });

  test('responseFrame echoes the client correlation id', () => {
    expect(responseFrame(9, { ok: true })).toEqual({ kind: 'response', requestId: 9, result: { ok: true } });
  });

  test('errorFrame omits requestId for connection-level failures', () => {
    const connectionError = errorFrame('version-mismatch', 'expected 1');
    expect(Object.keys(connectionError).sort()).toEqual(['code', 'kind', 'message']);

    const requestError = errorFrame('bad-parameters', 'missing path', 4);
    expect(requestError.requestId).toBe(4);
  });

  test('clusterEventPayload omits absent optional fields', () => {
    expect(Object.keys(clusterEventPayload(1, 'member-up'))).toEqual(['kind', 'atMs', 'event']);
    expect(clusterEventPayload(1, 'leader-changed', undefined, null).leader).toBeNull();
  });

  test('stats samples are cumulative counters the UI can differentiate', () => {
    const sample = statsSamplePayload({
      atMs: 1_000,
      uptimeMs: 500,
      runtime: 'bun',
      actorCount: 3,
      actorsStarted: 10,
      actorsStopped: 7,
      actorsRestarted: 1,
      deadLetters: 2,
      mailboxBacklog: 5,
      topMailboxes: [{ path: '/user/a', size: 5, stashSize: 0, suspended: false }],
    });
    expect(sample.kind).toBe('stats-sample');
    expect(sample.cluster).toBeUndefined();
    expect(sample.topMailboxes[0]!.path).toBe('/user/a');
  });
});
