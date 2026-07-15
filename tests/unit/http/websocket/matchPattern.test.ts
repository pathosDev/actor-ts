import { describe, expect, test } from 'bun:test';
import { matchWebsocketPattern } from '../../../../src/http/websocket/matchPattern.js';

describe('matchWebsocketPattern', () => {
  test('matches a static pattern exactly', () => {
    expect(matchWebsocketPattern('/feed', '/feed')).toEqual({});
    expect(matchWebsocketPattern('/feed', '/other')).toBeNull();
  });

  test('captures and URI-decodes a param segment', () => {
    expect(matchWebsocketPattern('/room/:id', '/room/42')).toEqual({ id: '42' });
    expect(matchWebsocketPattern('/room/:id', '/room/a%20b')).toEqual({ id: 'a b' });
  });

  test('returns null on segment-count mismatch', () => {
    expect(matchWebsocketPattern('/room/:id', '/room/1/2')).toBeNull();
    expect(matchWebsocketPattern('/a/b', '/a')).toBeNull();
  });

  // security audit WS-1 — regression guard.
  //
  // Before the fix, `decodeURIComponent('%ZZ')` threw `URIError`, which
  // propagated out of the Express upgrade handler's fire-and-forget IIFE as
  // an *unhandled rejection* — process-fatal under Node's default, reachable
  // pre-auth by any unauthenticated client sending `GET /room/%ZZ` with an
  // `Upgrade: websocket` header.  The matcher must now treat a malformed
  // escape as a non-match (→ 404) rather than throwing.
  test('malformed percent-encoding in a param yields no match, never throws (WS-1)', () => {
    expect(() => matchWebsocketPattern('/room/:id', '/room/%ZZ')).not.toThrow();
    expect(matchWebsocketPattern('/room/:id', '/room/%ZZ')).toBeNull();
    // Truncated multi-byte UTF-8 escape — also malformed.
    expect(() => matchWebsocketPattern('/room/:id', '/room/%E0%A4%A')).not.toThrow();
    expect(matchWebsocketPattern('/room/:id', '/room/%E0%A4%A')).toBeNull();
  });

  test('malformed escape in a STATIC segment does not throw (compared verbatim)', () => {
    expect(() => matchWebsocketPattern('/x/y', '/%ZZ/y')).not.toThrow();
    expect(matchWebsocketPattern('/x/y', '/%ZZ/y')).toBeNull();
  });
});
