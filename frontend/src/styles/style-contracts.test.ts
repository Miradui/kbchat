import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const STYLES_DIR = 'src/styles/';

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith('.css') ? [full] : [];
  });
}

function extractCustomProperties(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    result[match[1]] = match[2].trim().replace(/\s+/g, ' ');
  }
  return result;
}

describe('style contracts', () => {
  it('keeps explicit dark theme tokens and system dark media query tokens identical', () => {
    const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');
    const explicitDarkMatch = tokensCss.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);
    const mediaDarkMatch = tokensCss.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([\s\S]*?)\n\s*\}\s*\}/);

    expect(explicitDarkMatch).not.toBeNull();
    expect(mediaDarkMatch).not.toBeNull();

    const explicitTokens = extractCustomProperties(explicitDarkMatch![1]);
    const mediaTokens = extractCustomProperties(mediaDarkMatch![1]);

    expect(Object.keys(explicitTokens).length).toBeGreaterThan(20);
    expect(explicitTokens).toEqual(mediaTokens);
  });

  it('keeps each theme accent preset consistent across light, explicit dark, and system dark blocks', () => {
    const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');
    const rootMatch = tokensCss.match(/:root\s*\{([\s\S]*?)\n\}/);
    const rootDarkMatch = tokensCss.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);
    expect(rootMatch).not.toBeNull();
    expect(rootDarkMatch).not.toBeNull();

    const rootTokens = extractCustomProperties(rootMatch![1]);
    const rootDarkTokens = extractCustomProperties(rootDarkMatch![1]);
    const presets = ['sage-green', 'terracotta', 'indigo'] as const;

    for (const preset of ['slate-blue', ...presets] as const) {
      expect(rootTokens[`--swatch-${preset}`]).toBeTruthy();
      expect(rootDarkTokens[`--swatch-${preset}`]).toBeTruthy();
    }

    for (const preset of presets) {
      const lightMatch = tokensCss.match(new RegExp(`:root\\[data-accent='${preset}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
      const darkMatch = tokensCss.match(new RegExp(`:root\\[data-theme='dark'\\]\\[data-accent='${preset}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
      const mediaMatch = tokensCss.match(new RegExp(`@media\\s*\\(prefers-color-scheme:\\s*dark\\)\\s*\\{\\s*:root:not\\(\\[data-theme='light'\\]\\)\\[data-accent='${preset}'\\]\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*\\}`));

      expect(lightMatch, `${preset} light block`).not.toBeNull();
      expect(darkMatch, `${preset} explicit dark block`).not.toBeNull();
      expect(mediaMatch, `${preset} system dark block`).not.toBeNull();

      const lightTokens = extractCustomProperties(lightMatch![1]);
      for (const required of ['--canvas', '--accent', '--accent-wash', '--accent-line', '--action', '--brand-panel']) {
        expect(lightTokens[required], `${preset} light ${required}`).toBeTruthy();
      }

      const explicitDark = extractCustomProperties(darkMatch![1]);
      const mediaDark = extractCustomProperties(mediaMatch![1]);
      expect(Object.keys(explicitDark).length).toBeGreaterThan(20);
      expect(explicitDark).toEqual(mediaDark);
    }
  });

  it('forbids raw color literals outside tokens.css', () => {
    const nonTokenFiles = cssFiles(STYLES_DIR).filter((file) => !file.endsWith('tokens.css'));
    const colorPattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/g;

    for (const file of nonTokenFiles) {
      const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const matches = stripped.match(colorPattern) ?? [];
      expect(matches, `${file} contains raw color literals`).toEqual([]);
    }
  });

  it('uses z-index tokens rather than magic numbers for all floating layers', () => {
    const filesToCheck = ['src/styles/primitives.css', 'src/styles/app-shell.css'];
    for (const file of filesToCheck) {
      const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const declarations = stripped.match(/z-index\s*:\s*[^;]+;/g) ?? [];
      const nonTokenLayers = declarations.filter((decl) => {
        const value = decl.replace(/z-index\s*:\s*|;/g, '').trim();
        return value !== '1' && !value.startsWith('var(--z-');
      });
      expect(nonTokenLayers, `${file} should use --z-* tokens`).toEqual([]);
    }
  });

  it('uses tokenized font sizes and canonical font weights outside tokens.css', () => {
    const nonTokenFiles = cssFiles(STYLES_DIR).filter((file) => !file.endsWith('tokens.css'));
    const rawFontSizePattern = /font-size\s*:\s*\d+(?:px|rem|em)\b/g;
    const intermediateWeightPattern = /font-weight\s*:\s*(450|550|560|620|650)\b/g;

    for (const file of nonTokenFiles) {
      const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(stripped.match(rawFontSizePattern) ?? [], `${file} contains raw font-size`).toEqual([]);
      expect(stripped.match(intermediateWeightPattern) ?? [], `${file} contains intermediate font-weight`).toEqual([]);
    }
  });

  it('does not leave undefined .ui-visually-hidden or .ui-checkbox-label references in tsx', () => {
    function tsxFiles(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return tsxFiles(full);
        return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
      });
    }
    for (const file of tsxFiles('src')) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/\bui-visually-hidden\b/);
      expect(content).not.toMatch(/\bui-checkbox-label\b/);
    }
  });
});
