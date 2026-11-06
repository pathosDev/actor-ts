/**
 * The grammar of a `.env` file — the variables `Config.load` makes available
 * to substitutions behind the real environment (#1785).
 *
 * A parser of its own rather than `util.parseEnv`, which Node has and Deno
 * does not, so one grammar holds on all three runtimes.  It is Node's
 * (`--env-file`, `util.parseEnv`), checked against Node 26 case by case:
 *
 *   - `KEY=value`, one per line; `export KEY=value` is the same assignment.
 *   - Whitespace around the key and around an unquoted value is dropped.
 *   - A value in `'…'`, `"…"` or `` `…` `` is the text between the quotes, and
 *     may span lines — a PEM key fits.  Inside `"…"`, `\n` is a line break;
 *     no other escape is read, in any quotes.
 *   - `#` starts a comment, anywhere in an unquoted value, so a value with a
 *     `#` in it goes in quotes.
 *   - `$VAR` is kept as written.  Node does not expand it, and an expansion
 *     here would make a bcrypt hash (`$2b$10$…`) depend on the environment.
 *   - The last assignment of a key wins; a line without `=` is ignored.
 *
 * One difference from Node: a byte-order mark at the start of the file is
 * dropped rather than read into the first key's name, the way the config
 * files are read.
 */

/** A newline — named so the scanner reads as the grammar above. */
const NEWLINE = '\n';
const QUOTES: ReadonlySet<string> = new Set(['"', "'", '`']);

/**
 * The variables `text` assigns, as an object with no prototype.
 *
 * No prototype, because a key is whatever the file says: `__proto__=x` is a
 * variable of that name, kept as an own property, and nothing it holds can
 * reach `Object.prototype`.
 *
 * Never throws, and never quotes the file.  A line that is not an assignment
 * is skipped, and an opening quote with no closing one is read the way Node
 * reads it — as the value up to the end of its line, quote included — so a
 * malformed line cannot put a secret from the file into an error message.
 */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const variables: Record<string, string> = Object.create(null);
  const source = (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/g, NEWLINE);
  let at = 0;
  while (at < source.length) {
    const lineEnd = endOfLine(source, at);
    const line = source.slice(at, lineEnd);
    const equals = line.indexOf('=');
    const trimmed = line.trimStart();
    if (equals < 0 || trimmed.startsWith('#')) {
      at = lineEnd + 1;
      continue;
    }
    const name = withoutExport(line.slice(0, equals).trim());
    let valueStart = at + equals + 1;
    while (source[valueStart] === ' ' || source[valueStart] === '\t') valueStart++;
    const quote = source[valueStart];
    const closing = quote !== undefined && QUOTES.has(quote) ? source.indexOf(quote, valueStart + 1) : -1;
    let value: string;
    if (closing >= 0) {
      value = source.slice(valueStart + 1, closing);
      if (quote === '"') value = value.split('\\n').join(NEWLINE);
      at = endOfLine(source, closing) + 1;
    } else {
      const comment = source.indexOf('#', valueStart);
      const valueEnd = comment >= 0 && comment < lineEnd ? comment : lineEnd;
      value = source.slice(valueStart, valueEnd).trim();
      at = lineEnd + 1;
    }
    if (name !== '') variables[name] = value;
  }
  return variables;
}

function endOfLine(source: string, from: number): number {
  const index = source.indexOf(NEWLINE, from);
  return index < 0 ? source.length : index;
}

/** `export NAME` is the assignment `NAME`; `export` alone, or `exported`, is a name. */
function withoutExport(name: string): string {
  const match = /^export[ \t]+(.+)$/.exec(name);
  return match === null ? name : match[1]!.trim();
}
