/**
 * Cluster-wide session-token store, backed by DistributedData.
 *
 * Tokens are issued on `login`, stored in an `LWWMap<token,
 * {username, issuedAt}>` keyed `chat.sessions`, and gossiped to
 * every node — so when the HTTP-singleton fails over, the new
 * holder already knows the existing tokens and can resume client
 * sessions without forcing them through the credentials flow
 * again.
 *
 * `LWWMap` is the right CRDT for this: each key (token) is owned
 * by one writer at a time (the node that minted it), conflicts are
 * impossible in practice, and the per-key tombstone-via-LWW gives
 * us a deterministic `revoke` operation.
 *
 * **TTL**: tokens are considered expired `TOKEN_TTL_MS` after their
 * `issuedAt` stamp.  Expired tokens stay in the map (DD doesn't GC
 * tombstones cheaply) but `lookup()` filters them out.  A
 * follow-up improvement could sweep the map periodically.
 *
 * **Crypto**: tokens are 32 bytes from `crypto.getRandomValues`,
 * encoded as hex — 64-character opaque strings.  Plenty of entropy
 * for a demo; production would also bind tokens to e.g. an HMAC
 * over `username || issuedAt` so the server can validate without
 * a DD lookup.
 */
import { LWWMap } from '../../../../src/crdt/index.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';

const TOKENS_KEY = 'chat.sessions';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOKEN_BYTES = 32;

interface TokenEntry {
  readonly username: string;
  readonly issuedAt: number;
}

export class SessionStore {
  constructor(private readonly dd: DistributedDataHandle) {}

  /** Mint a fresh token for `username` and persist it cluster-wide. */
  mintToken(username: string): string {
    const token = randomHex(TOKEN_BYTES);
    const entry: TokenEntry = { username, issuedAt: Date.now() };
    this.dd.update<LWWMap<string, TokenEntry>>(
      TOKENS_KEY,
      () => LWWMap.empty<string, TokenEntry>(),
      (cur) => cur.put(this.dd.selfReplicaId(), token, entry),
    );
    return token;
  }

  /**
   * Resolve a token to its owning username, or `null` if the token
   * is unknown / revoked / expired.  Pure read — no DD mutation.
   */
  lookupToken(token: string): string | null {
    const map = this.dd.get<LWWMap<string, TokenEntry>>(TOKENS_KEY);
    if (!map) return null;
    const entry = map.get(token);
    if (!entry) return null;
    if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) return null;
    return entry.username;
  }

  /**
   * Tombstone the token — explicit logout / forced revoke.  Other
   * replicas converge via standard LWWMap merge.  After revoke,
   * `lookupToken(token)` returns `null` everywhere.
   */
  revokeToken(token: string): void {
    this.dd.update<LWWMap<string, TokenEntry>>(
      TOKENS_KEY,
      () => LWWMap.empty<string, TokenEntry>(),
      (cur) => cur.remove(this.dd.selfReplicaId(), token),
    );
  }
}

/* ------------------------------- helpers ------------------------------- */

function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
