/**
 * `redactedUrlLabel` as v0.17.0 shipped it, frozen: the oracle of the
 * differential test in `RedactUrlCredentials.test.ts` (#1458).
 *
 * The label is what the broker lifecycle events and the WebSocket client's
 * oversize warning hand on as already safe, and the work on #1458 rewrote it
 * three times before a release.  A rewrite may mask further than the release
 * did — that was the point of all three — but never less: a credential the
 * released label hid and the next one prints is a regression an operator
 * cannot see coming.  Holding the new label to the old one over generated
 * input is the only check that covers the shapes nobody wrote a row for.
 *
 * A copy rather than `git show v0.17.0:…` at test time, on purpose: the oracle
 * has to exist in a shallow clone, in a tarball and on a runner with no tags,
 * and it must not move when the tree does.  The code below is the v0.17.0
 * source of `src/util/RedactUrlCredentials.ts` with its comments trimmed and
 * its two exports renamed; the logic is byte for byte the release's.  Do not
 * "fix" it — a defect here is a defect the release had, which is exactly what
 * the comparison needs to see.
 */

const USERINFO_MASK = '***';
const SCHEME_SEPARATOR = '://';
const AT_SIGN = 0x40;
const SLASH = 0x2f;
const QUESTION_MARK = 0x3f;
const NUMBER_SIGN = 0x23;
const QUERY_OR_FRAGMENT = /[?#]/;

/** v0.17.0's `redactUrlCredentials`: the userinfo ends at the last `@` before the first `/`, `?` or `#`. */
export function releasedRedactUrlCredentials(value: string): string {
  const pieces: string[] = [];
  let copiedTo = 0;
  let searchFrom = 0;
  for (;;) {
    const separator = value.indexOf(SCHEME_SEPARATOR, searchFrom);
    if (separator === -1) break;
    const authorityStart = separator + SCHEME_SEPARATOR.length;
    searchFrom = authorityStart;
    if (!precededByScheme(value, separator)) continue;
    const userinfoEnd = lastAtInAuthority(value, authorityStart);
    if (userinfoEnd === -1) continue;
    pieces.push(value.slice(copiedTo, authorityStart), USERINFO_MASK);
    copiedTo = userinfoEnd;
    searchFrom = userinfoEnd + 1;
  }
  if (pieces.length === 0) return value;
  pieces.push(value.slice(copiedTo));
  return pieces.join('');
}

function isSchemeStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSchemeCharacter(code: number): boolean {
  return isSchemeStart(code)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b || code === 0x2d || code === 0x2e;
}

function precededByScheme(value: string, separator: number): boolean {
  for (let index = separator - 1; index >= 0; index--) {
    const code = value.charCodeAt(index);
    if (isSchemeStart(code)) return true;
    if (!isSchemeCharacter(code)) return false;
  }
  return false;
}

function lastAtInAuthority(value: string, from: number): number {
  let found = -1;
  for (let index = from; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === SLASH || code === QUESTION_MARK || code === NUMBER_SIGN) break;
    if (code === AT_SIGN) found = index;
  }
  return found;
}

/** v0.17.0's `redactedUrlLabel`: a WHATWG parse, or the scan cut at its query when the parse fails. */
export function releasedRedactedUrlLabel(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return stripQueryAndFragment(releasedRedactUrlCredentials(value));
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function stripQueryAndFragment(value: string): string {
  const cut = value.search(QUERY_OR_FRAGMENT);
  return cut === -1 ? value : value.slice(0, cut);
}
