/**
 * Placeholder-based HTML templates for outgoing mail.
 *
 * The framework already has {@link html} — a tagged template that escapes
 * every interpolation.  It needs the markup as a JavaScript literal at the
 * call site, which is exactly what a mail template usually is not: the
 * snippet lives in HOCON, in a database row, or in a file an operator
 * edits.  This class covers that case, with the same escaping doctrine:
 *
 * ```ts
 * const alert = new EmailTemplate('<h1>{{title}}</h1><p>{{detail}}</p>');
 *
 * const body = alert.clone()
 *   .setValue('title', 'Disk almost full')
 *   .setValue('detail', report)       // escaped, whatever `report` contains
 *   .render();
 * bridge.tell({ kind: 'send', email: { to: 'ops@example.com', html: body } });
 * ```
 *
 * **Values are escaped by default.**  A template is filled with data the
 * sender rarely controls — a subject line from an alert, a customer name, a
 * stack trace — and the one opt-out is the {@link SafeHtml} brand the rest
 * of the framework already uses: `setValue('row', rawHtml(fragment))`
 * inserts verbatim, and says so at the call site.
 *
 * **It is deliberately logic-less** — no loops, no conditionals, no
 * expressions.  This is a placeholder substituter, not a template engine;
 * anything conditional belongs in the code that decides what to put in.
 * Building the markup from parts with `html` and passing the result in as
 * a `SafeHtml` value covers the cases that would otherwise want a loop.
 */
import { escapeHtml, SafeHtml } from '../../util/Html.js';

/** A template that could not be filled or rendered as asked. */
export class EmailTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailTemplateError';
  }
}

/** What may be substituted for a placeholder. */
export type EmailTemplateValue = string | number | boolean | SafeHtml;

/**
 * A placeholder occurrence: `{{name}}`, with optional inner whitespace.
 * Anything that does not look like an identifier is left alone, so prose
 * such as `{{ see the docs }}` survives untouched rather than becoming an
 * error the author cannot act on.
 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export class EmailTemplate {
  private readonly names: ReadonlyArray<string>;
  private readonly values = new Map<string, string>();

  /** Parse `source`, collecting the placeholders it declares. */
  constructor(private readonly source: string) {
    const names: string[] = [];
    for (const match of source.matchAll(PLACEHOLDER_RE)) {
      const name = match[1]!;
      if (!names.includes(name)) names.push(name);
    }
    this.names = names;
  }

  /** The placeholders this template declares, in the order they appear. */
  get placeholderNames(): ReadonlyArray<string> {
    return this.names;
  }

  /**
   * Set one placeholder.  Strings, numbers and booleans are HTML-escaped;
   * a {@link SafeHtml} value is inserted verbatim.  Setting the same name
   * twice keeps the last value.
   *
   * @throws EmailTemplateError if the template has no such placeholder —
   * a typo would otherwise be invisible until the value silently failed to
   * appear in a mail that had already been sent.
   */
  setValue(name: string, value: EmailTemplateValue): this {
    if (!this.names.includes(name)) {
      throw new EmailTemplateError(
        `EmailTemplate: unknown placeholder '${name}'`
        + (this.names.length > 0 ? ` — the template declares ${this.names.join(', ')}` : ' — the template declares none'),
      );
    }
    this.values.set(name, value instanceof SafeHtml ? value.value : escapeHtml(String(value)));
    return this;
  }

  /** Set several placeholders at once.  Same rules as {@link setValue}. */
  setValues(values: Readonly<Record<string, EmailTemplateValue>>): this {
    for (const [name, value] of Object.entries(values)) this.setValue(name, value);
    return this;
  }

  /**
   * A fresh template over the same source with no values set — parse once
   * at startup, fill one per message.
   */
  clone(): EmailTemplate {
    return new EmailTemplate(this.source);
  }

  /**
   * Substitute every placeholder and return the HTML.
   *
   * @throws EmailTemplateError if any placeholder is still unset, naming
   * all of them: a mail that goes out with a literal `{{amount}}` in it
   * cannot be recalled, so this fails before sending rather than after.
   */
  render(): string {
    const missing = this.names.filter((name) => !this.values.has(name));
    if (missing.length > 0) {
      throw new EmailTemplateError(`EmailTemplate: no value for ${missing.join(', ')}`);
    }
    return this.source.replace(PLACEHOLDER_RE, (_match, name: string) => this.values.get(name)!);
  }
}
