import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `touch.css` only ever raises existing controls to 44px at the mobile breakpoint --
 * it introduces no classes of its own. So every class it names must be defined
 * somewhere else, and a selector that matches nothing is a rule that silently does
 * nothing. That is easy to write and impossible to see: the first draft of this file
 * styled `.ui-field--inline`, which does not exist anywhere in the project.
 */

const TOUCH = 'src/styles/touch.css';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk('src');
const css = readFileSync(TOUCH, 'utf8');
// Comments are prose and mention class names; only the rules count.
const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '');
const referenced = [...new Set([...rules.matchAll(/\.([a-zA-Z0-9_-]+)/gu)].map((match) => match[1]))];

const otherCss = files
  .filter((path) => path.endsWith('.css') && !path.endsWith('touch.css'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
// Tests are excluded deliberately. This file names `.ui-field--inline` in the comment
// above as the example of a dead selector, so scanning tests would let that selector
// prove its own existence -- and the same trap applies to any class a test mentions.
const source = files
  .filter((path) => (path.endsWith('.tsx') || path.endsWith('.ts')) && !/\.test\.tsx?$/u.test(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

describe('touch.css', () => {
  it('names at least the controls it is supposed to cover', () => {
    // A tripwire against the file being emptied or an import being dropped: if these
    // stop being listed, the touch sizes are gone and nothing else would notice.
    for (const cls of ['ui-button', 'ui-icon-button', 'ui-segmented', 'ui-pagination__page', 'ui-menu-item']) {
      expect(referenced).toContain(cls);
    }
  });

  it.each(referenced)('styles .%s, which is defined elsewhere', (cls) => {
    const defined = otherCss.includes(`.${cls}`) || source.includes(cls);
    expect(defined, `.${cls} is not defined in any other stylesheet or used in any component`).toBe(true);
  });

  it('is scoped to the mobile breakpoint, not applied everywhere', () => {
    // Every declaration has to sit inside the media query. A rule that escaped it
    // would push desktop controls to 44px, which is the thing this file must not do.
    const outsideMedia = rules.split(/@media[^{]*\{/u)[0];
    expect(outsideMedia).not.toMatch(/\{/u);
    expect(rules).toMatch(/@media\s*\(max-width:\s*980px\)/u);
  });

  it('is imported by the stylesheet entry point, last', () => {
    const index = readFileSync('src/styles/index.css', 'utf8');
    const imports = [...index.matchAll(/@import\s+'([^']+)'/gu)].map((match) => match[1]);
    // Last, or a same-specificity page rule loaded later would win over the touch size.
    expect(imports[imports.length - 1]).toBe('./touch.css');
  });
});
