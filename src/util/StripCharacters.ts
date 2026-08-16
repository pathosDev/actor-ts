/**
 * Strip a repeated character from the ends of a string, in linear time.
 *
 * The obvious spelling of this is a regex — `value.replace(/\/+$/, '')` — and
 * it is quadratic (#1198).  `\/+$` is not anchored at the *start*, so the
 * engine tries it from every position: on a run of `n` slashes that is not at
 * the end, each start position consumes the rest of the run, fails `$`, and
 * backtracks through it, for O(n²).  It reads as a one-liner that could not
 * possibly be a problem, which is why the repository had six copies of it,
 * two of them on values a remote peer chooses (the decoded remainder of a
 * request path, and a hostname from a DNS or Kubernetes API response).
 *
 * A backwards index scan needs no regex at all and cannot backtrack, so the
 * cost is bounded by the run it strips rather than by the string it is in.
 * The alternation form (`/^\/+|\/+$/g`) has the same defect on the trailing
 * half and the same replacement, {@link stripSurrounding}.
 *
 * Both functions return the argument itself when nothing is stripped, so the
 * common case allocates nothing.
 */

/**
 * `value` without its trailing run of `character`.
 *
 * `character` is one character; a longer string is read as its first.
 */
export function stripTrailing(value: string, character: string): string {
  const code = character.charCodeAt(0);
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === code) end--;
  return end === value.length ? value : value.slice(0, end);
}

/**
 * `value` without its leading *and* trailing runs of `character`.
 *
 * A value that is nothing but that character strips to the empty string —
 * the leading run swallows it, exactly as `/^\/+|\/+$/g` did.
 */
export function stripSurrounding(value: string, character: string): string {
  const code = character.charCodeAt(0);
  const length = value.length;
  let start = 0;
  let end = length;
  while (start < end && value.charCodeAt(start) === code) start++;
  while (end > start && value.charCodeAt(end - 1) === code) end--;
  return start === 0 && end === length ? value : value.slice(start, end);
}
