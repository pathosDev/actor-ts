import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { PersistentActor, type MasterKeyRing } from '../../../src/persistence/index.js';

/**
 * The per-actor override sample on the snapshot-store backend page (#1430).
 *
 * The fence read `protected encryption() { return { keyRing: accountKeyRing }; }`
 * — not an `EncryptionConfig` (the ring field is `masterKeys`, and `mode` and
 * `info` are required), and `protected` narrows a hook `PersistentActor`
 * declares public, which does not compile.  Nothing noticed, because the
 * fence elides its generics and imports nothing, so `check:doc-samples`
 * classifies it as a fragment and never compiles it.
 *
 * So the sample gets a compiled twin: the class below carries the fence's
 * body line for line, and the test holds the page to it.  The two halves
 * bind under different gates, and it takes both:
 *
 *   - **`bun run typecheck:dev`** compiles the twin against the real
 *     `PersistentActor` — `bun test` transpiles without checking, so a twin
 *     that narrowed a hook or returned a bad config would pass here and fail
 *     there.
 *   - **`bun test`** holds the English and German fences to the twin's lines,
 *     so the page cannot drift from the code that compiles.
 *
 * The fence keeps `PersistentActor<...>` and imports nothing, deliberately: it
 * is a fragment on a page of fragments, and this file is what checks it.
 */

const accountKeyRing: MasterKeyRing = { active: { version: 1, key: new Uint8Array(32).fill(7) } };

type NoopCommand = { readonly kind: 'noop' };
type NoopEvent = { readonly kind: 'noop' };
type BalanceState = { readonly balance: number };

/** The twin.  Everything between the two marker comments is the fence's body. */
class Account extends PersistentActor<NoopCommand, NoopEvent, BalanceState> {
  readonly persistenceId = 'override-sample';
  initialState(): BalanceState { return { balance: 0 }; }
  onEvent(state: BalanceState): BalanceState { return state; }
  async onCommand(): Promise<void> { /* the sample overrides nothing else */ }

  // sample-body-start
  override compression() { return { algorithm: 'zstd' as const }; }
  override encryption() {
    return {
      mode: 'client-aes256-gcm' as const,
      masterKeys: accountKeyRing,
      info: 'acme/prod/snapshot/v1',
    };
  }
  // sample-body-end
}

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

function withUnixLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Lines with their shared indentation removed, so a class body and a fence body compare. */
function dedented(lines: readonly string[]): string[] {
  const indents = lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length);
  const shared = Math.min(...indents);
  return lines.map((line) => line.slice(shared));
}

function twinBody(): string[] {
  const source = withUnixLineEndings(readFileSync(import.meta.path, 'utf8')).split('\n');
  const start = source.findIndex((line) => line.trim() === '// sample-body-start');
  const end = source.findIndex((line) => line.trim() === '// sample-body-end');
  if (start < 0 || end <= start) throw new Error('the twin lost its sample-body markers');
  return dedented(source.slice(start + 1, end));
}

/**
 * The body of the one `class Account` fence under the page's per-actor
 * overrides heading — the lines between the class line and its closing brace.
 */
function fenceBody(path: string, heading: string): string[] {
  const page = withUnixLineEndings(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'));
  const sectionStart = page.indexOf(`\n${heading}\n`);
  if (sectionStart < 0) throw new Error(`${path}: the "${heading}" heading is gone — re-point this test.`);
  const fenceStart = page.indexOf('```ts\n', sectionStart);
  const fenceEnd = page.indexOf('\n```', fenceStart + 1);
  const lines = page.slice(fenceStart + '```ts\n'.length, fenceEnd).split('\n');
  if (!lines[0]?.startsWith('class Account extends PersistentActor<') || lines.at(-1) !== '}') {
    throw new Error(`${path}: the first fence under "${heading}" is no longer the Account override sample.`);
  }
  return dedented(lines.slice(1, -1));
}

const PAGES = [
  ['English', 'docs/src/content/docs/persistence/object-storage/snapshot-store-backend.mdx', '## Per-actor overrides'],
  ['German', 'docs/src/content/docs/de/persistence/object-storage/snapshot-store-backend.mdx', '## Per-Actor-Overrides'],
] as const;

describe('the snapshot-store backend override sample is the compiled twin (#1430)', () => {
  test.each(PAGES)('%s page: the fence body is the twin\'s, line for line', (_language, path, heading) => {
    expect(
      fenceBody(path, heading),
      `${path}: the per-actor override sample drifted from the twin in this file, which is the copy `
      + '`typecheck:dev` compiles. Change both together — the twin first, so the compiler sees it.',
    ).toEqual(twinBody());
  });

  test('the twin returns a config the object-storage store can act on', () => {
    // A runtime sanity check on the half `bun test` can see: the shape a
    // reader copies is the client-side mode with a ring and a context.
    const encryption = new Account().encryption();
    expect(encryption).toEqual({
      mode: 'client-aes256-gcm',
      masterKeys: accountKeyRing,
      info: 'acme/prod/snapshot/v1',
    });
  });
});
