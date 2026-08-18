import { describe, expect, test } from 'bun:test';
import { EmailTemplate, EmailTemplateError } from '../../../../src/io/broker/EmailTemplate.js';
import { html, rawHtml } from '../../../../src/util/Html.js';

describe('EmailTemplate — parsing', () => {
  test('collects the declared placeholders in order, without duplicates', () => {
    const template = new EmailTemplate('<h1>{{title}}</h1><p>{{body}}</p><footer>{{title}}</footer>');
    expect(template.placeholderNames).toEqual(['title', 'body']);
  });

  test('tolerates whitespace inside the braces', () => {
    const template = new EmailTemplate('{{ spaced }}');
    expect(template.placeholderNames).toEqual(['spaced']);
    expect(template.setValue('spaced', 'ok').render()).toBe('ok');
  });

  test('a template without placeholders renders unchanged', () => {
    const template = new EmailTemplate('<p>nothing to fill</p>');
    expect(template.placeholderNames).toEqual([]);
    expect(template.render()).toBe('<p>nothing to fill</p>');
  });

  // Prose in braces is far more likely than a placeholder the author forgot
  // to name legally, so it is left alone rather than made an error.
  test('braces that are not an identifier are left untouched', () => {
    const template = new EmailTemplate('{{ not a name }} and {{2fast}} and {{}}');
    expect(template.placeholderNames).toEqual([]);
    expect(template.render()).toBe('{{ not a name }} and {{2fast}} and {{}}');
  });
});

describe('EmailTemplate — substitution', () => {
  test('replaces every occurrence of a placeholder', () => {
    const rendered = new EmailTemplate('{{name}} <b>{{name}}</b>')
      .setValue('name', 'Ada')
      .render();
    expect(rendered).toBe('Ada <b>Ada</b>');
  });

  test('escapes values by default', () => {
    const rendered = new EmailTemplate('<p>{{comment}}</p>')
      .setValue('comment', '<script>alert("x")</script>')
      .render();
    expect(rendered).toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  });

  test('escapes quotes so a value cannot break out of an attribute', () => {
    const rendered = new EmailTemplate('<a title="{{tip}}">x</a>')
      .setValue('tip', '"><script>')
      .render();
    expect(rendered).toBe('<a title="&quot;&gt;&lt;script&gt;">x</a>');
  });

  test('numbers and booleans are coerced', () => {
    const rendered = new EmailTemplate('{{count}}/{{done}}')
      .setValues({ count: 42, done: false })
      .render();
    expect(rendered).toBe('42/false');
  });

  test('a SafeHtml value is inserted verbatim', () => {
    const rendered = new EmailTemplate('<div>{{fragment}}</div>')
      .setValue('fragment', rawHtml('<b>bold</b>'))
      .render();
    expect(rendered).toBe('<div><b>bold</b></div>');
  });

  test('an html`` fragment composes in, still escaping its own interpolations', () => {
    const rows = html`<li>${'<danger>'}</li>`;
    const rendered = new EmailTemplate('<ul>{{rows}}</ul>')
      .setValue('rows', rows)
      .render();
    expect(rendered).toBe('<ul><li>&lt;danger&gt;</li></ul>');
  });

  test('the last value written wins', () => {
    const rendered = new EmailTemplate('{{x}}')
      .setValue('x', 'first')
      .setValue('x', 'second')
      .render();
    expect(rendered).toBe('second');
  });

  test('setValues fills several at once', () => {
    const rendered = new EmailTemplate('{{a}}-{{b}}')
      .setValues({ a: '1', b: '2' })
      .render();
    expect(rendered).toBe('1-2');
  });

  // A substituted value must not itself be scanned for placeholders, or a
  // value containing `{{x}}` would reach into the template.
  test('a value that looks like a placeholder is not substituted again', () => {
    const rendered = new EmailTemplate('{{a}}{{b}}')
      .setValues({ a: '{{b}}', b: 'B' })
      .render();
    expect(rendered).toBe('{{b}}B');
  });
});

describe('EmailTemplate — errors', () => {
  test('setting an unknown placeholder throws and names the known ones', () => {
    const template = new EmailTemplate('{{known}}');
    expect(() => template.setValue('typo', 'x')).toThrow(EmailTemplateError);
    expect(() => template.setValue('typo', 'x')).toThrow(/unknown placeholder 'typo'.*known/);
  });

  test('rendering with unset placeholders throws and names all of them', () => {
    const template = new EmailTemplate('{{a}}{{b}}{{c}}').setValue('b', 'B');
    expect(() => template.render()).toThrow(EmailTemplateError);
    expect(() => template.render()).toThrow(/no value for a, c/);
  });
});

describe('EmailTemplate — reuse', () => {
  test('clone shares the source but not the values', () => {
    const base = new EmailTemplate('<p>{{name}}</p>');
    const first = base.clone().setValue('name', 'one');
    const second = base.clone().setValue('name', 'two');

    expect(first.render()).toBe('<p>one</p>');
    expect(second.render()).toBe('<p>two</p>');
    // The original is untouched, so it still refuses to render.
    expect(() => base.render()).toThrow(EmailTemplateError);
  });

  test('render is pure — calling it twice yields the same output', () => {
    const template = new EmailTemplate('{{a}}|{{a}}').setValue('a', 'x');
    expect(template.render()).toBe(template.render());
    expect(template.render()).toBe('x|x');
  });
});
