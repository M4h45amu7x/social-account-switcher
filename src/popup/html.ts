// A tiny HTML builder: every interpolated value is escaped unless it is marked safe on purpose.
// The popup renders with `innerHTML`, so this is the one place that decides what is markup.

export class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Marks a string as already-safe markup (icons and other constants only, never user data). */
export const raw = (markup: string): Safe => new Safe(markup);

/** Tagged template: `html\`<b>${userText}</b>\`` escapes userText. false, null and undefined print nothing. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += part(v) + (strings[i + 1] ?? '');
  });
  return new Safe(out);
}

function part(v: unknown): string {
  if (v === false || v === null || v === undefined) return '';
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
