import { describe, expect, test } from 'bun:test';
import { writeRawHttpResponse } from '../../../../src/http/ws/rawResponse.js';

function fakeSocket() {
  let data = '';
  let destroyed = false;
  return {
    sock: {
      write: (s: string) => { data += s; return true; },
      destroy: () => { destroyed = true; },
    },
    get data() { return data; },
    get destroyed() { return destroyed; },
  };
}

describe('writeRawHttpResponse', () => {
  test('emits a well-formed response and destroys the socket', () => {
    const f = fakeSocket();
    writeRawHttpResponse(f.sock, { status: 404, body: 'Not Found' });
    expect(f.data.startsWith('HTTP/1.1 404 Not Found\r\n')).toBe(true);
    expect(f.data.endsWith('\r\n\r\nNot Found')).toBe(true);
    expect(f.destroyed).toBe(true);
  });

  // SECURITY_AUDIT.md WS-6 — an `authorize` guard that echoes attacker-
  // influenced data into a reject-response header must not be able to inject
  // extra header lines or a body onto the raw upgrade socket.
  test('strips CR/LF from app-supplied header values (no response splitting)', () => {
    const f = fakeSocket();
    writeRawHttpResponse(f.sock, {
      status: 403,
      body: 'denied',
      headers: { 'x-echo': 'a\r\nSet-Cookie: pwned=1\r\n\r\ninjected-body' },
    });
    // The injected value must not appear as its own header line…
    expect(f.data).not.toContain('\r\nSet-Cookie:');
    // …and there must be exactly one header/body boundary (no smuggled body).
    expect(f.data.split('\r\n\r\n').length).toBe(2);
  });

  test('strips CR/LF from header names too', () => {
    const f = fakeSocket();
    writeRawHttpResponse(f.sock, {
      status: 400,
      body: 'x',
      headers: { 'x-a\r\nx-b': 'v' },
    });
    expect(f.data.split('\r\n\r\n').length).toBe(2);
    expect(f.data).not.toContain('\r\nx-b');
  });
});
