import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every full-height measurement in this project uses `dvh`, not `vh`.
 *
 * `vh` is fixed to the largest viewport, so it ignores both the mobile URL bar and the
 * soft keyboard: a panel sized in `vh` keeps claiming space that the keyboard is now
 * covering, and a text field inside it ends up under the keyboard. `dvh` shrinks with
 * them. The one `vh` left in the project was the padding above the command palette's
 * search box, which held up to 140px of empty space at the top while the panel below
 * it -- capped in `dvh` -- shrank from the bottom.
 *
 * `vw` is deliberately not covered: horizontal space is not affected by either, so
 * `vw` is the correct unit there and appears in the rail width.
 */
/* Relative to the project root, which is where Vitest runs -- `import.meta.url` is a
   transform URL here, not a filesystem path. */
const STYLES_DIR = 'src/styles/';

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith('.css') ? [full] : [];
  });
}

describe('viewport units', () => {
  const files = cssFiles(STYLES_DIR);

  it('finds the stylesheets to check', () => {
    // A broken walk would make every case below pass by having nothing to look at.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((path) => [path.slice(STYLES_DIR.length), path] as const))(
    '%s uses dvh rather than vh',
    (_name, path) => {
      const withoutComments = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
      const offenders = [...withoutComments.matchAll(/[\d.]+\s*vh\b/giu)]
        .map((match) => match[0])
        .filter((unit) => !/d\s*vh$/iu.test(unit) && !/s\s*vh$/iu.test(unit));

      expect(offenders).toEqual([]);
    },
  );

  it('still uses dvh somewhere, so the rule above is not vacuous', () => {
    const all = files.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(all).toMatch(/dvh/u);
  });
});
