import { callerFile, registryEntries } from './Registry.js';

/**
 * The expected value of an assertion whose subject genuinely behaves
 * differently per platform, because the *runtime* does (#1410).
 *
 * A test like that has two shapes available without this helper, and both are
 * wrong:
 *
 *   - **Assert one platform's behaviour.**  The suite is then red on the other,
 *     for a reason that is true.  That was `develop` when this landed: three
 *     tests asserted that `server.maxConnections` closes a connection past the
 *     cap, which Bun does on Windows and does not on `ubuntu-latest` (#1409).
 *   - **Skip on the other platform.**  The behaviour is then asserted nowhere,
 *     and the skip has no owner and no expiry.
 *
 * The difference between a skip and an asserted divergence is what happens on
 * the day the runtimes converge: a skip stays quietly green forever, while an
 * assertion goes **red** and forces the caveat to be revisited.  That is the
 * whole reason this exists, and it is why the failure is a feature.
 *
 * Every call is backed by an entry in `tests/quarantine.json` carrying the
 * issue that owns the divergence and the date the entry expires; there is no
 * way to add one without both.  `tests/unit/ci/QuarantineRegistry.test.ts`
 * enforces that in both directions and fails once an entry is past its date.
 *
 * ```ts
 * expect(await closedWithin(second, 3_000)).toBe(
 *   platformDependent(import.meta, 'max-connections enforced by the runtime', {
 *     win32: true,
 *     default: false,
 *   }),
 * );
 * ```
 *
 * `win32` is spelled the way `process.platform` spells it rather than
 * "windows", so the mapping from the value the runtime reports to the branch
 * taken is visible at the call site instead of hidden in here.
 */
export function platformDependent<T>(
  importMeta: ImportMeta,
  label: string,
  expectations: { readonly win32: T; readonly default: T },
): T {
  const file = callerFile(importMeta);
  const entry = registryEntries().find(
    (candidate) =>
      candidate.kind === 'platform-expectation' &&
      candidate.file === file &&
      candidate.label === label,
  );
  if (entry === undefined) {
    throw new Error(
      `platformDependent: no registry entry for ${file} / "${label}".\n` +
      'A per-platform expectation needs an owner and an expiry date, so add one to ' +
      'tests/quarantine.json:\n' +
      `  { "kind": "platform-expectation", "file": "${file}", "label": "${label}",\n` +
      '    "issue": <the issue that will remove this>, "since": "<today>", "expires": "<within 45 days>",\n' +
      '    "reason": "<what each runtime actually does, and how that was measured>", "history": [] }\n' +
      'If the two platforms are supposed to agree, the divergence is the bug — fix that instead.',
    );
  }
  return process.platform === 'win32' ? expectations.win32 : expectations.default;
}
