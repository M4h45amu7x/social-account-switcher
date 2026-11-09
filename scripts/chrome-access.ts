// Second guardrail behind Biome: outside the two adapter files, src/ must not mention `chrome` at all
// (docs/design.md 8.2). Comments and type-only code are stripped first by Bun's transpiler, so this finds
// runtime uses such as `chrome.x`, `globalThis.chrome`, `self['chrome']`, `const { chrome } = window`
// and `document.defaultView.chrome`.
// It's a guard against honest mistakes, not a sandbox: building the name at runtime
// (`self['ch' + 'rome']`) gets past it, so code review still matters.

export const CHROME_ADAPTERS = [
  'src/background/chrome-adapter.ts',
  'src/popup/runtime.ts',
] as const;

// `chrome` as a whole word; a hyphen counts as part of the word so the import path './chrome-adapter'
// doesn't match.
const CHROME_WORD = /(?<![\w$-])chrome(?![\w$-])/;

const transpiler = new Bun.Transpiler({ loader: 'ts', trimUnusedImports: true });

/** Returns the transpiled lines of `source` that mention `chrome` (empty = clean). */
export function findChromeAccess(source: string): string[] {
  const code = transpiler.transformSync(source);
  return code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => CHROME_WORD.test(line));
}

export const isAdapter = (path: string): boolean =>
  (CHROME_ADAPTERS as readonly string[]).includes(path.split('\\').join('/'));
