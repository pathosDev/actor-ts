import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **The built-in brokers that can abort a connect in flight are the three the
 * docs name** (#1478).
 *
 * A breaker's `call-timeout` and a connect deadline both end an attempt through
 * `abortConnectAttempt`, and only a subclass that implements it can make its
 * connect reject early; every other broker keeps the base class's default,
 * which warns and lets the connect run until it settles.  The BrokerActor page
 * (EN + DE) and the hook's JSDoc say which brokers abort.  This holds that
 * list to the source in both directions: a broker that gains the hook should
 * be named there, and one that loses it must stop being named, or the docs
 * promise an abort that never comes.
 */

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'src');

/** The files the docs and the hook's JSDoc name as implementing the abort. */
const DOCUMENTED_IMPLEMENTERS = [
  'http/websocket/WebsocketClientActor.ts',
  'io/broker/SseActor.ts',
  'io/broker/TcpSocketActor.ts',
] as const;

/** Every `.ts` file under `directory`, as a path relative to `src/`. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [relative(SOURCE_ROOT, path).split('\\').join('/')] : [];
  });
}

/** Whether `source` overrides the hook in code — a comment naming it does not count. */
function overridesAbort(source: string): boolean {
  return source.split(/\r?\n/).some((line) => {
    const code = line.trim();
    return !code.startsWith('*') && !code.startsWith('//') && /\boverride\s+abortConnectAttempt\s*\(/.test(code);
  });
}

describe('the brokers that abort a connect in flight', () => {
  test('the scan sees an override in code and not in a comment', () => {
    expect(overridesAbort('  protected override abortConnectAttempt(cause: Error): void {')).toBe(true);
    expect(overridesAbort('  protected override  abortConnectAttempt (cause: Error): void {')).toBe(true);
    expect(overridesAbort('   * A subclass may `override abortConnectAttempt(cause)` to abort.')).toBe(false);
    expect(overridesAbort('  // override abortConnectAttempt(cause) here once the driver can')).toBe(false);
    expect(overridesAbort('  protected abortConnectAttempt(_cause: Error): void {')).toBe(false);
  });

  test('are exactly the three the BrokerActor page and the hook\'s JSDoc name', () => {
    const implementers = sourceFiles(SOURCE_ROOT)
      .filter((file) => overridesAbort(readFileSync(join(SOURCE_ROOT, file), 'utf8')))
      .sort();
    expect(
      implementers,
      'The set of brokers that implement abortConnectAttempt changed.  Name the new set in the call-timeout '
      + 'bullet of docs/src/content/docs/io/broker-actor-base.mdx (EN + DE) and in the abortConnectAttempt JSDoc '
      + 'in src/io/broker/BrokerActor.ts, then update DOCUMENTED_IMPLEMENTERS here.',
    ).toEqual([...DOCUMENTED_IMPLEMENTERS]);
  });
});
