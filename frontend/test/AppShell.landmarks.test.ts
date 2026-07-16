import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
  });
}

describe('application landmarks', () => {
  it('keeps the sole main landmark in AppShell', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const owners = collectTsxFiles(sourceRoot)
      .filter((file) => /<main\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file).replaceAll('\\', '/'));

    expect(owners).toEqual(['src/layouts/AppShell.tsx']);
  });
});
