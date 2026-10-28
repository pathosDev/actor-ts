/**
 * Verification keys for {@link JwtAuth} (#810): a configured key imported with
 * its algorithm bound, and the issuer's JWK set — fetched, cached, and
 * refreshed when a token names a key it does not hold.
 *
 * **One algorithm per key, fixed at import.**  WebCrypto binds the algorithm
 * to the `CryptoKey`: an RSA key imported for RSASSA-PKCS1-v1_5 cannot be used
 * for HMAC — `verify` throws — and every key here is imported exactly once,
 * for exactly one algorithm.  That is what makes the classic RS256-to-HS256
 * confusion impossible by construction: the attack needs the RSA public key's
 * bytes imported as an HMAC secret, and nothing here ever imports anything
 * as HMAC except a configured secret.  A JWK set is never read for HMAC keys
 * at all.
 *
 * **The key set fails closed.**  A token is only ever verified against a key
 * this process holds, from a fetch that succeeded within the cache lifetime.
 * When that is not the case and a fetch does not fix it, the answer is
 * {@link JwksUnavailableError} — the request that needed the set is refused
 * (503), never let through and never verified against a stale set.  Only an
 * algorithm a set can serve ever asks it ({@link keySetServes}).
 */
import type { Clock } from '../../Clock.js';
import type { Logger } from '../../Logger.js';
import { redactUrlCredentials } from '../../util/RedactUrlCredentials.js';
import { HttpClient } from '../HttpClient.js';
import type { HttpClientOptionsType } from '../HttpClientOptions.js';
import { MIN_RSA_PUBLIC_EXPONENT, PRIVATE_JWK_MEMBERS, isAcceptedRsaPublicExponent } from './JwtAuthOptions.js';
import type { JwtAlgorithm, JwtPublicJwk, JwtPublicKey, JwtSecret } from './JwtAuthOptions.js';

/** A key bound to the one algorithm it verifies. */
export type VerificationKey = {
  /** The `kid` a token names it by, when it has one. */
  readonly keyId: string | undefined;
  readonly algorithm: JwtAlgorithm;
  readonly key: CryptoKey;
  /** The exact length a signature by this key has — anything else is malformed. */
  readonly signatureBytes: number;
};

/** How each algorithm is imported and verified in WebCrypto — the binding itself. */
type AlgorithmBinding = {
  readonly importParameters: RsaHashedImportParams | EcKeyImportParams | HmacImportParams;
  readonly verifyParameters: AlgorithmIdentifier | EcdsaParams;
};

const BINDINGS: Readonly<Record<JwtAlgorithm, AlgorithmBinding>> = {
  RS256: {
    importParameters: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verifyParameters: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES256: {
    importParameters: { name: 'ECDSA', namedCurve: 'P-256' },
    verifyParameters: { name: 'ECDSA', hash: 'SHA-256' },
  },
  HS256: {
    importParameters: { name: 'HMAC', hash: 'SHA-256' },
    verifyParameters: { name: 'HMAC' },
  },
};

/**
 * An ES256 signature is the raw `r || s` pair, 32 bytes each (RFC 7518
 * §3.4) — the DER encoding other tooling produces is 70-72 bytes and is not
 * a JWS signature.
 */
const ES256_SIGNATURE_BYTES = 64;

/** An HS256 signature is the full SHA-256 output. */
const HS256_SIGNATURE_BYTES = 32;

/** RFC 7518 §3.3 — an RS256 key must be at least 2048 bits. */
const MIN_RSA_MODULUS_BITS = 2048;

/** The SubjectPublicKeyInfo block the configured PEM keys come in. */
const PEM_PUBLIC_KEY = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----/;

/** WebCrypto, or a clear refusal on a runtime without it. */
export function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('JwtAuth needs WebCrypto (globalThis.crypto.subtle), which this runtime does not provide');
  }
  return subtle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The public members of a JWK and nothing else — what is handed to `importKey`. */
function publicMembers(jwk: Record<string, unknown>): JsonWebKey {
  return jwk['kty'] === 'RSA'
    ? { kty: 'RSA', n: jwk['n'] as string, e: jwk['e'] as string }
    : { kty: 'EC', crv: jwk['crv'] as string, x: jwk['x'] as string, y: jwk['y'] as string };
}

/** An RSA public exponent as a refusal names it: its value while a number holds it exactly (six bytes), else its length. */
function exponentText(exponent: unknown): string {
  if (!(exponent instanceof Uint8Array)) return 'not reported by this runtime';
  return exponent.length <= 6 ? String(exponent.reduce((value, byte) => value * 256 + byte, 0)) : `${exponent.length} bytes long`;
}

/**
 * `key` as a {@link VerificationKey}, after the checks an import alone does
 * not make.  The RSA ones are made here, on what WebCrypto itself parsed,
 * because this is the one step every route shares — a PEM key, whose
 * exponent the options validator never sees, and a JWK-set entry, which
 * never meets the validator at all.
 */
function bound(keyId: string | undefined, algorithm: JwtAlgorithm, key: CryptoKey): VerificationKey {
  if (algorithm === 'RS256') {
    const { modulusLength, publicExponent } = key.algorithm as RsaHashedKeyAlgorithm;
    if (modulusLength < MIN_RSA_MODULUS_BITS) {
      throw new Error(`an RS256 key must be at least ${MIN_RSA_MODULUS_BITS} bits (RFC 7518 §3.3), this one has ${modulusLength}`);
    }
    // Not left to WebCrypto: Bun and Deno refuse an exponent of 1 one way or
    // another, but Node imports the key and verifies with it.
    if (!(publicExponent instanceof Uint8Array) || !isAcceptedRsaPublicExponent(publicExponent)) {
      throw new Error(
        `an RS256 key's public exponent must be odd and at least ${MIN_RSA_PUBLIC_EXPONENT} (RFC 8017 §3.1), this one is ${exponentText(publicExponent)}`,
      );
    }
    return { keyId, algorithm, key, signatureBytes: Math.ceil(modulusLength / 8) };
  }
  return { keyId, algorithm, key, signatureBytes: algorithm === 'ES256' ? ES256_SIGNATURE_BYTES : HS256_SIGNATURE_BYTES };
}

/** The DER bytes of a PEM "PUBLIC KEY" block. */
function pemBody(pem: string): Uint8Array {
  const body = PEM_PUBLIC_KEY.exec(pem)?.[1];
  if (body === undefined) throw new Error('not a PEM "PUBLIC KEY" block');
  return Uint8Array.from(atob(body.replace(/\s+/g, '')), (character) => character.charCodeAt(0));
}

/** A configured RS256 / ES256 key, imported for its algorithm only. */
export async function importPublicKey(entry: JwtPublicKey): Promise<VerificationKey> {
  const binding = BINDINGS[entry.algorithm];
  const material = entry.key;
  const key = typeof material === 'string'
    ? await subtleCrypto().importKey('spki', pemBody(material) as BufferSource, binding.importParameters, false, ['verify'])
    : await subtleCrypto().importKey('jwk', publicMembers(material as Record<string, unknown>), binding.importParameters, false, ['verify']);
  const keyId = entry.keyId ?? (typeof material === 'string' ? undefined : (material as JwtPublicJwk).kid);
  return bound(keyId, entry.algorithm, key);
}

/** A configured HS256 secret, imported for HMAC-SHA-256 only. */
export async function importSecret(entry: JwtSecret): Promise<VerificationKey> {
  const bytes = typeof entry.secret === 'string' ? new TextEncoder().encode(entry.secret) : entry.secret;
  const key = await subtleCrypto().importKey('raw', bytes as BufferSource, BINDINGS.HS256.importParameters, false, ['verify']);
  return bound(entry.keyId, 'HS256', key);
}

/**
 * Whether `signature` is `key`'s signature over `signingInput`, verified with
 * the algorithm the key was bound to at import — never one a token names.
 * A refusal from WebCrypto itself counts as a failed verification.
 */
export async function verifySignature(key: VerificationKey, signature: Uint8Array, signingInput: Uint8Array): Promise<boolean> {
  try {
    return await subtleCrypto().verify(BINDINGS[key.algorithm].verifyParameters, key.key, signature as BufferSource, signingInput as BufferSource);
  } catch {
    return false;
  }
}

/** A key type a JWK set is read for, and the algorithm its keys are bound to. */
type SetKeyType = {
  readonly algorithm: JwtAlgorithm;
  readonly kty: string;
  /** The curve an EC key must be on; unset for RSA. */
  readonly crv?: string;
};

/**
 * What a JWK set can serve: RSA keys bound to RS256, P-256 keys bound to
 * ES256, and nothing else.  The one place that knows it — {@link
 * setEntryAlgorithm} reads an entry against these rows and {@link
 * keySetServes} answers from them, so the two cannot disagree.  An `oct`
 * (HMAC) key has no row: a set never yields an HS256 key.
 */
const SET_KEY_TYPES: readonly SetKeyType[] = [
  { algorithm: 'RS256', kty: 'RSA' },
  { algorithm: 'ES256', kty: 'EC', crv: 'P-256' },
];

/**
 * Whether a JWK set can hold a key for `algorithm` at all.  A token signed
 * with one it cannot — HS256 — has nothing to ask the set: it is answered
 * from the configured secrets alone, so it never waits on a fetch and an
 * unreachable set cannot turn it into a 503.
 */
export function keySetServes(algorithm: JwtAlgorithm): boolean {
  return SET_KEY_TYPES.some((type) => type.algorithm === algorithm);
}

/**
 * The algorithm a JWK-set entry's key type binds it to — RS256 for an RSA
 * key, ES256 for a P-256 one — or `undefined` for anything else, an `oct`
 * (HMAC) key above all.
 */
function setEntryAlgorithm(entry: Record<string, unknown>): JwtAlgorithm | undefined {
  return SET_KEY_TYPES.find((type) =>
    entry['kty'] === type.kty && (type.crv === undefined || entry['crv'] === type.crv))?.algorithm;
}

/**
 * Why an entry of `algorithm`'s key type cannot be bound to it, or
 * `undefined` when it can: it carries private members, or its own `alg`,
 * `use` or `key_ops` says it is not an RS256 / ES256 signature key, or its
 * `kid` is unusable.  Private members are asked about first — an issuer that
 * publishes a private key has made the one mistake worth naming as such,
 * whatever else the entry says.
 */
function setEntryRefusal(entry: Record<string, unknown>, algorithm: JwtAlgorithm): string | undefined {
  const privateMember = PRIVATE_JWK_MEMBERS.find((member) => entry[member] !== undefined);
  if (privateMember !== undefined) return `it carries private key material (${privateMember})`;
  if (entry['alg'] !== undefined && entry['alg'] !== algorithm) return `its alg names another algorithm than ${algorithm}`;
  if (entry['use'] !== undefined && entry['use'] !== 'sig') return "its use is not 'sig'";
  const operations = entry['key_ops'];
  if (operations !== undefined && !(Array.isArray(operations) && operations.includes('verify'))) {
    return "its key_ops do not include 'verify'";
  }
  if (entry['kid'] !== undefined && (typeof entry['kid'] !== 'string' || entry['kid'].length === 0)) {
    return 'its kid is not a non-empty string';
  }
  return undefined;
}

/**
 * One JWK-set entry as a verification key, or the reason it cannot be one
 * here.  A skipped entry costs the issuer's other keys nothing.
 */
async function importSetEntry(entry: unknown, allowed: ReadonlySet<JwtAlgorithm>): Promise<VerificationKey | string> {
  if (!isRecord(entry)) return 'it is not a JSON object';
  const algorithm = setEntryAlgorithm(entry);
  if (algorithm === undefined) return 'it is not an RSA or P-256 key';
  if (!allowed.has(algorithm)) return `its key type verifies ${algorithm}, which algorithms does not allow`;
  const refusal = setEntryRefusal(entry, algorithm);
  if (refusal !== undefined) return refusal;
  try {
    const key = await subtleCrypto().importKey('jwk', publicMembers(entry), BINDINGS[algorithm].importParameters, false, ['verify']);
    return bound(entry['kid'] as string | undefined, algorithm, key);
  } catch (error) {
    // A malformed or undersized key is skipped, never trusted.
    return `it could not be imported: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * How a skipped entry is named in a log line: its position, and its `kid`
 * when it has one — JSON-quoted, so a line break in it cannot start a
 * forged line of its own.  How long it can be is bounded by the document's
 * size cap.
 */
function entryLabel(entry: unknown, index: number): string {
  const keyId = isRecord(entry) ? entry['kid'] : undefined;
  return typeof keyId === 'string' && keyId.length > 0 ? `entry ${index} (kid ${JSON.stringify(keyId)})` : `entry ${index}`;
}

/** What a JWK-set document yielded: the keys, and a line for every entry that was not one. */
type ImportedKeySet = {
  readonly keys: readonly VerificationKey[];
  /** `entry <index> (kid "…"): <reason>`, one per skipped entry. */
  readonly skipped: readonly string[];
};

/** Every usable key of a JWK-set document (RFC 7517 §5); throws when the document is not one. */
async function importKeySet(document: unknown, allowed: ReadonlySet<JwtAlgorithm>): Promise<ImportedKeySet> {
  if (!isRecord(document) || !Array.isArray(document['keys'])) {
    throw new Error('the response is not a JWK set (no "keys" array)');
  }
  const entries: readonly unknown[] = document['keys'];
  const imported = await Promise.all(entries.map((entry) => importSetEntry(entry, allowed)));
  const keys: VerificationKey[] = [];
  const skipped: string[] = [];
  imported.forEach((result, index) => {
    if (typeof result === 'string') skipped.push(`${entryLabel(entries[index], index)}: ${result}`);
    else keys.push(result);
  });
  return { keys, skipped };
}

/** The issuer's key set could not be obtained — refused as 503, never let through. */
export class JwksUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JwksUnavailableError';
  }
}

/** Fetches the key-set document from `url` and returns it parsed.  The seam a test replaces. */
export type JwksDocumentFetcher = (url: string) => Promise<unknown>;

/** What {@link JwksKeySet} needs from the resolved middleware options. */
export type JwksKeySetSettings = {
  readonly url: string;
  /** Only keys for these algorithms are imported. */
  readonly algorithms: ReadonlySet<JwtAlgorithm>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly cacheTtlMs: number;
  readonly minRefreshIntervalMs: number;
  /** Where a skipped entry is reported, at debug. */
  readonly logger: Logger;
};

/**
 * The production fetcher: a standalone `HttpClient` of its own, with the
 * deadline, the size cap and the redirect refusal set on the client *and*
 * passed on every request — the request's own values are what win, and an
 * explicit `timeoutMs` there is the only thing `0` could ever have disarmed.
 *
 * A redirect is refused rather than followed: the operator named the URL the
 * keys come from, and a hop would let the answering host nominate another.
 */
function httpDocumentFetcher(settings: JwksKeySetSettings): JwksDocumentFetcher {
  const limits = {
    timeoutMs: settings.timeoutMs,
    maxResponseBytes: settings.maxResponseBytes,
    redirect: 'error',
  } as const;
  const clientOptions: HttpClientOptionsType = {
    defaultTimeoutMs: settings.timeoutMs,
    maxResponseBytes: settings.maxResponseBytes,
    redirect: 'error',
  };
  const client = new HttpClient(clientOptions);
  return async (url) => {
    const response = await client.get(url, {
      ...limits,
      headers: { accept: 'application/jwk-set+json, application/json' },
    });
    if (response.status !== 200) throw new Error(`the key set answered ${response.status}`);
    return response.json();
  };
}

/**
 * The issuer's JWK set, cached by key id.
 *
 * - **Loaded on demand**, by the first request that needs it, and trusted for
 *   `cacheTtlMs`; the first request after that refetches.
 * - **Refreshed on an unknown `kid`**, since that is what an issuer's key
 *   rotation looks like from here — at most once per `minRefreshIntervalMs`,
 *   counted from the last attempt, so a client sending random key ids costs
 *   the issuer one fetch per interval and not one per request.
 * - **Single-flight**: every request that needs a fetch while one is running
 *   waits for that one.
 * - **Fail closed**: when the set cannot be fetched and the cache cannot
 *   answer, {@link JwksUnavailableError}; after a failed attempt the next is
 *   again at most once per `minRefreshIntervalMs`, so an unreachable issuer
 *   is not hammered by every request either.
 * - **Says what it skipped**: every entry a fetch yields no key for is
 *   logged at debug with the reason, so an operator asking why a published
 *   key never verifies anything has an answer that a request cannot give.
 */
export class JwksKeySet {
  private keys: readonly VerificationKey[] = [];
  /** When the current set was fetched; `undefined` until a fetch succeeds. */
  private loadedAt: number | undefined;
  /** When the last fetch started, successful or not. */
  private lastAttemptAt: number | undefined;
  private lastAttemptFailed = false;
  private inFlight: Promise<void> | undefined;
  private readonly fetchDocument: JwksDocumentFetcher;
  /** The URL as it may appear in a message: credentials masked. */
  private readonly displayUrl: string;

  constructor(
    private readonly settings: JwksKeySetSettings,
    private readonly clock: Clock,
    fetchDocument?: JwksDocumentFetcher,
  ) {
    this.fetchDocument = fetchDocument ?? httpDocumentFetcher(settings);
    this.displayUrl = redactUrlCredentials(settings.url);
  }

  /**
   * The keys that can verify a token naming `keyId` (or no key id) and
   * `algorithm` — fetching, refreshing or refusing as the class describes.
   * An empty answer means the set holds no such key; it is never a
   * substitute for a set that could not be obtained.
   */
  async keysFor(keyId: string | undefined, algorithm: JwtAlgorithm): Promise<readonly VerificationKey[]> {
    await this.ensureCurrent();
    const found = this.matching(keyId, algorithm);
    // No refresh when the id is known under another algorithm: that token
    // is refused for the mismatch, and rotation would not change the answer.
    if (found.length > 0 || keyId === undefined || this.keys.some((key) => key.keyId === keyId)) return found;
    return (await this.refreshForUnknownKey()) ? this.matching(keyId, algorithm) : found;
  }

  private matching(keyId: string | undefined, algorithm: JwtAlgorithm): readonly VerificationKey[] {
    return this.keys.filter((key) => key.algorithm === algorithm && (keyId === undefined || key.keyId === keyId));
  }

  /**
   * A set fetched within the cache lifetime, or {@link JwksUnavailableError}.
   *
   * A current set answers at once, even while a refresh some unknown key id
   * started is running: a request whose key is cached has nothing to wait
   * for, and must not inherit that refresh's failure.
   */
  private async ensureCurrent(): Promise<void> {
    const now = this.clock.now();
    if (this.loadedAt !== undefined && now - this.loadedAt < this.settings.cacheTtlMs) return;
    if (this.inFlight !== undefined) return this.inFlight;
    if (this.lastAttemptFailed && this.withinRefreshFloor(now)) throw this.unavailable();
    return this.refresh();
  }

  /** Whether an unknown key id may refetch the set now; throws when the set cannot say. */
  private async refreshForUnknownKey(): Promise<boolean> {
    if (this.inFlight !== undefined) {
      await this.inFlight;
      return true;
    }
    if (this.withinRefreshFloor(this.clock.now())) {
      // The last fetch failed: the key may well be in the set this process
      // could not read, so "unknown" would be a guess.
      if (this.lastAttemptFailed) throw this.unavailable();
      return false;
    }
    await this.refresh();
    return true;
  }

  private withinRefreshFloor(now: number): boolean {
    return this.lastAttemptAt !== undefined && now - this.lastAttemptAt < this.settings.minRefreshIntervalMs;
  }

  /** Start a fetch unless one is running, and wait for it. */
  private refresh(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    // Set before the first await, so a request arriving in the same tick
    // already counts this attempt against the refresh floor.
    this.lastAttemptAt = this.clock.now();
    try {
      const document = await this.fetchDocument(this.settings.url);
      const imported = await importKeySet(document, this.settings.algorithms);
      for (const skipped of imported.skipped) {
        this.settings.logger.debug(`JwtAuth: the JWK set at ${this.displayUrl} yields no key for ${skipped}`);
      }
      this.keys = imported.keys;
      this.loadedAt = this.clock.now();
      this.lastAttemptFailed = false;
    } catch (cause) {
      this.lastAttemptFailed = true;
      throw this.unavailable(cause);
    }
  }

  private unavailable(cause?: unknown): JwksUnavailableError {
    const reason = cause instanceof Error ? `: ${cause.message}` : cause === undefined ? ' (the last attempt failed)' : '';
    return new JwksUnavailableError(`the JWK set at ${this.displayUrl} could not be fetched${reason}`, { cause });
  }
}
