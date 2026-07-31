/**
 * Write a plain HTTP/1.1 response onto a raw upgrade socket, then close
 * it.  Used by the Express backend to reject a WebSocket upgrade before
 * the handshake completes (404 for an unknown path, or the response an
 * authorize guard returned).  Since no `101` was sent, the client is
 * still speaking HTTP and sees a normal error response.
 */
import type { HttpResponse } from '../types.js';

/** The minimal raw-socket surface we write to (a `node:net` Socket). */
export interface RawUpgradeSocket {
  write(data: string): unknown;
  destroy(): void;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function writeRawHttpResponse(socket: RawUpgradeSocket, response: HttpResponse): void {
  let body: string;
  let contentType = response.contentType;
  if (response.body === undefined || response.body === null) {
    body = '';
  } else if (typeof response.body === 'string') {
    body = response.body;
    contentType ??= 'text/plain; charset=utf-8';
  } else if (response.body instanceof Uint8Array) {
    body = Buffer.from(response.body).toString('utf8');
    contentType ??= 'application/octet-stream';
  } else {
    body = JSON.stringify(response.body);
    contentType ??= 'application/json; charset=utf-8';
  }

  const statusText = STATUS_TEXT[response.status] ?? '';
  const lines = [
    `HTTP/1.1 ${response.status} ${statusText}`,
    `content-type: ${contentType ?? 'text/plain; charset=utf-8'}`,
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
  ];
  if (response.headers) {
    for (const [k, v] of Object.entries(response.headers)) {
      // Strip CR/LF from the header name and value before writing them to
      // the raw upgrade socket.  Without this, an `authorize` guard that
      // returns a reject response carrying an attacker-influenced header
      // value could inject extra header lines or a body (HTTP response
      // splitting) — see security audit WS-6.
      const name = String(k).replace(/[\r\n]/g, '');
      const value = String(v).replace(/[\r\n]/g, '');
      if (name.length === 0) continue;
      lines.push(`${name}: ${value}`);
    }
  }
  try {
    socket.write(lines.join('\r\n') + '\r\n\r\n' + body);
  } catch {
    /* peer already gone */
  }
  try {
    socket.destroy();
  } catch {
    /* already destroyed */
  }
}
