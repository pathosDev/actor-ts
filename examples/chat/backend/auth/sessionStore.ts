/**
 * Cluster-wide session-token store — JWT-style HMAC-bound tokens
 * + DD-backed revocation list.  Hardened in #99 (Option A).
 *
 * **Token shape**: `<base64url(payload)>.<base64url(sig)>` where
 *   payload = JSON `{ u: username, i: issuedAt, e: exp }`
 *   sig     = HMAC-SHA256(payload-bytes, serverSecret)
 *
 * **Why HMAC-bound instead of opaque-random**: tokens self-validate.
 * `lookupToken` doesn't need to read DD to confirm a token was issued
 * by *this cluster* — re-HMAC the payload, compare in constant time,
 * check `exp`, done.  DD is only consulted for the revocation list
 * (an `LWWMap<token, true>`, ~one entry per logout), which is the
 * smaller, hot-path-friendly data structure.  Before #99 the store
 * was an `LWWMap<token, {username, issuedAt}>` — every successful
 * resume hit DD even though the data was already in the token.
 *
 * **Why DD-LWWMap for revocation instead of a Set?**  A revoked
 * token must converge cluster-wide so a singleton-failover doesn't
 * resurrect a logged-out session.  LWWMap is right-shaped: each
 * entry is `(token, true)`, one writer per key (the node that took
 * the logout), conflicts are impossible in practice, tombstones are
 * never resurrected (we never "un-revoke").  The map grows by one
 * entry per logout — for a sample-scale cluster, this stays small
 * forever (expired-and-revoked entries could be GC'd by a sweep,
 * out of scope today).
 *
 * **TTL**: 24 hours from `issuedAt`.  The `exp` field inside the
 * payload is authoritative — bumping `TOKEN_TTL_MS` doesn't extend
 * already-issued tokens (their `exp` is baked in at mint time).
 *
 * **Server secret**: read from `CHAT_TOKEN_SECRET` env var.  In its
 * absence we derive a stable demo-only secret from a hardcoded
 * string (logged with a warning at start-up).  Production must set
 * this to a strong random value, shared across every cluster node so
 * resume works during failover.
 */
import * as crypto from 'node:crypto';
import { LWWMap } from '../../../../src/crdt/index.js';
import type { DistributedDataHandle } from '../../../../src/crdt/DistributedData.js';

const REVOCATION_KEY = 'chat.session-revocations';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
/** Fallback secret used when `CHAT_TOKEN_SECRET` is unset.  Demo
 *  only — the server logs a loud warning when it falls back. */
const DEMO_FALLBACK_SECRET = 'chat-sample-demo-secret-do-not-use-in-production';

interface TokenPayload {
  /** Username. */
  readonly u: string;
  /** Issued-at, ms since epoch. */
  readonly i: number;
  /** Expires-at, ms since epoch. */
  readonly e: number;
}

export class SessionStore {
  private readonly secret: Buffer;
  /** True iff we fell back to the demo secret — logged at startup. */
  readonly usingDemoSecret: boolean;

  constructor(
    private readonly dd: DistributedDataHandle,
    /** Override for tests; production uses `CHAT_TOKEN_SECRET` env. */
    secret?: string,
  ) {
    const fromEnv = secret ?? process.env['CHAT_TOKEN_SECRET'];
    this.usingDemoSecret = !fromEnv;
    this.secret = Buffer.from(fromEnv ?? DEMO_FALLBACK_SECRET, 'utf-8');
  }

  /** Mint a JWT-style token binding `username`, `issuedAt`, `exp`. */
  mintToken(username: string): string {
    const now = Date.now();
    const payload: TokenPayload = { u: username, i: now, e: now + TOKEN_TTL_MS };
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    const sig = crypto.createHmac('sha256', this.secret).update(payloadBytes).digest();
    return `${b64url(payloadBytes)}.${b64url(sig)}`;
  }

  /**
   * Resolve a token to its owning username, or `null` if the token
   * is malformed / forged / expired / revoked.  Pure read — no DD
   * mutation.
   */
  lookupToken(token: string): string | null {
    const parsed = this.parseAndVerify(token);
    if (!parsed) return null;
    // Revocation check — the only DD read on the resume hot path.
    const revoked = this.dd.get<LWWMap<string, true>>(REVOCATION_KEY);
    if (revoked?.get(token) !== undefined) return null;
    return parsed.u;
  }

  /**
   * Mark a token as revoked cluster-wide.  Idempotent — re-revoking
   * the same token is a no-op LWW write.  After convergence,
   * `lookupToken(token)` returns `null` on every node.
   */
  revokeToken(token: string): void {
    // No need to verify the token first — the worst case is we add a
    // garbage key to the revocation set, which never matches any
    // real token and gets ignored on lookup.  Skipping verification
    // also means logout works even with a corrupted token.
    this.dd.update<LWWMap<string, true>>(
      REVOCATION_KEY,
      () => LWWMap.empty<string, true>(),
      (cur) => cur.put(this.dd.selfReplicaId(), token, true),
    );
  }

  /* ------------------------------ internals ------------------------------ */

  /** Parse, verify HMAC + exp.  Returns the payload on success. */
  private parseAndVerify(token: string): TokenPayload | null {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    let payloadBytes: Buffer;
    let sig: Buffer;
    try {
      payloadBytes = Buffer.from(token.slice(0, dot), 'base64url');
      sig = Buffer.from(token.slice(dot + 1), 'base64url');
    } catch {
      return null;
    }
    const expected = crypto.createHmac('sha256', this.secret).update(payloadBytes).digest();
    if (expected.length !== sig.length) return null;
    if (!crypto.timingSafeEqual(expected, sig)) return null;
    let payload: TokenPayload;
    try {
      const json = JSON.parse(payloadBytes.toString('utf-8')) as unknown;
      if (!isPayload(json)) return null;
      payload = json;
    } catch {
      return null;
    }
    if (Date.now() >= payload.e) return null;
    return payload;
  }
}

/* ------------------------------- helpers ------------------------------- */

function b64url(b: Buffer): string {
  return b.toString('base64url');
}

function isPayload(v: unknown): v is TokenPayload {
  return typeof v === 'object'
    && v !== null
    && typeof (v as { u?: unknown }).u === 'string'
    && typeof (v as { i?: unknown }).i === 'number'
    && typeof (v as { e?: unknown }).e === 'number';
}
