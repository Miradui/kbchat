// @ts-nocheck -- This Vitest-only source reads CSS through Node APIs; app builds stay DOM-typed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const legacyStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8').replace(/\s+/g, ' ');
const layoutStyles = readFileSync(resolve(process.cwd(), 'src/styles/layouts.css'), 'utf8').replace(/\s+/g, ' ');
const premiumStyles = readFileSync(resolve(process.cwd(), 'src/styles/premium.css'), 'utf8').replace(/\s+/g, ' ');
const componentStyles = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8').replace(/\s+/g, ' ');
const chatStyles = readFileSync(resolve(process.cwd(), 'src/styles/pages/chat.css'), 'utf8').replace(/\s+/g, ' ');
const tagStyles = readFileSync(resolve(process.cwd(), 'src/styles/pages/tags.css'), 'utf8').replace(/\s+/g, ' ');
const styleIndex = readFileSync(resolve(process.cwd(), 'src/styles/index.css'), 'utf8').replace(/\s+/g, ' ');

function zIndex(styles: string, selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = styles.match(new RegExp(`${escaped}\\s*\\{[^}]*z-index:\\s*(\\d+)`))?.[1];
  if (!value) throw new Error(`Missing z-index for ${selector}`);
  return Number(value);
}

describe('mobile interaction target styles', () => {
  it.each([
    '.star-button',
    'button.citation-summary-button',
    '.pager button',
  ])('gives %s a 44px target at the mobile breakpoint', (selector) => {
    expect(legacyStyles).toMatch(new RegExp(
      `@media \\(max-width: 980px\\).*?${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*min-height: 44px`,
    ));
  });

  it('gives category names a 44px target in the navigation drawer', () => {
    expect(layoutStyles).toMatch(
      /@media \(max-width: 980px\).*?button\.category-name[^}]*min-height: 44px/,
    );
  });

  it('gives compact chat commands 44px mobile touch targets', () => {
    for (const selector of [
      '.chat-title-form > button',
      '.chat-thread-actions > button',
      '.chat-thread-actions > .table-actions > button',
      '.message-actions .secondary-button',
      '.chat-composer > button',
    ]) {
      expect(chatStyles).toMatch(new RegExp(
        `@media \\(max-width: 680px\\).*?${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*min-height:\\s*44px`,
      ));
    }
  });

  it('gives document drawer commands 44px mobile touch targets', () => {
    for (const selector of [
      '.document-detail-actions > *',
      '.document-recycle-drawer .drawer-actions > button',
    ]) {
      expect(legacyStyles).toMatch(new RegExp(
        `@media \\(max-width: 680px\\).*?${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*min-height:\\s*44px`,
      ));
    }
  });

  it('wraps category management actions without mobile horizontal overflow', () => {
    expect(layoutStyles).toMatch(
      /@media \(max-width: 680px\).*?\.category-tree[^}]*overflow-x:\s*hidden/,
    );
    expect(layoutStyles).toMatch(
      /@media \(max-width: 680px\).*?\.category-row[^}]*grid-template-columns:\s*44px minmax\(0,\s*1fr\)/,
    );
    expect(layoutStyles).toMatch(
      /@media \(max-width: 680px\).*?\.category-actions[^}]*grid-column:\s*1\s*\/\s*-1[^}]*flex-wrap:\s*wrap/,
    );
  });

  it('gives link-style actions a 44px target at the mobile breakpoint', () => {
    for (const selector of ['.link-button']) {
      expect(legacyStyles).toMatch(new RegExp(
        `@media \\(max-width: 980px\\).*?${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*min-height: 44px`,
      ));
    }
    for (const selector of ['.button-link', '.secondary-link']) {
      expect(premiumStyles).toMatch(new RegExp(
        `@media \\(max-width: 980px\\).*?${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*min-height: 44px`,
      ));
    }
  });

  it.each(['.primary-nav__cta', '.app-global-search input'])(
    'gives %s a 44px target in the mobile app shell',
    (selector) => {
      expect(layoutStyles).toMatch(new RegExp(
        `@media \\(max-width: 980px\\).*?${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*min-height: 44px`,
      ));
    },
  );
});

describe('action layout styles', () => {
  it('keeps chat landing actions visually separated', () => {
    expect(legacyStyles).toMatch(/\.kb-launch-actions[^}]*gap:\s*(?:8|10|12)px/);
  });

  it.each(['.overview-grid'])(
    'stacks %s at the mobile breakpoint',
    (selector) => {
      expect(legacyStyles).toMatch(new RegExp(
        `@media \\(max-width: 980px\\).*?${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*grid-template-columns: 1fr`,
      ));
    },
  );

  it('keeps responsive chat structure in one page stylesheet', () => {
    expect(styleIndex).toContain("@import './pages/chat.css'");
    expect(legacyStyles).not.toMatch(/\.chat-shell\s*\{[^}]*(?:grid-template-columns|grid-template-areas)/);
    expect(premiumStyles).not.toMatch(/\.chat-shell\s*\{[^}]*(?:grid-template-columns|grid-template-areas)/);
  });

  it('keeps user and assistant message alignment under chat page ownership', () => {
    expect(chatStyles).toMatch(/\.chat-thread \.message-bubble\.user[^}]*justify-self:\s*end/);
    expect(chatStyles).toMatch(/\.chat-thread \.message-bubble\.user[^}]*color:\s*#fff/);
    expect(chatStyles).toMatch(/\.chat-thread \.message-bubble\.assistant[^}]*justify-self:\s*start/);
  });

  it('avoids repeating the citation heading inside the responsive drawer', () => {
    expect(chatStyles).toMatch(
      /@media \(max-width: 1439px\).*?\.chat-citations-aux\.is-open \.chat-citation-intro h2[^}]*display:\s*none/,
    );
  });

  it('gives inline citations a 44px mobile touch target', () => {
    expect(chatStyles).toMatch(
      /@media \(max-width: 680px\).*?\.inline-citation[^}]*min-height:\s*44px[^}]*min-width:\s*44px/,
    );
  });

  it('separates category dialog fields with a stable form rhythm', () => {
    expect(componentStyles).toMatch(/\.category-dialog-form[^}]*display:\s*grid/);
    expect(componentStyles).toMatch(/\.category-dialog-form[^}]*gap:\s*(?:8|12|16)px/);
  });

  it('keeps a visible native disclosure marker for optional knowledge-base settings', () => {
    expect(legacyStyles).toMatch(/\.kb-form-advanced\s*>\s*summary[^}]*display:\s*list-item/);
    expect(legacyStyles).not.toMatch(/\.kb-form-advanced\s*>\s*summary[^}]*display:\s*flex/);
  });

  it('keeps fixed overlays viewport-anchored after the page entrance animation', () => {
    const entranceKeyframes = premiumStyles.match(/@keyframes premium-enter\s*{.*?}\s*}/)?.[0] ?? '';
    expect(entranceKeyframes).not.toContain('transform:');
  });

  it('keeps responsive chat panel sizing in the page stylesheet', () => {
    expect(chatStyles).toMatch(
      /@media \(max-height: 640px\).*?\.chat-main-panel[^}]*min-height:\s*clamp\(/,
    );
    expect(premiumStyles).not.toMatch(
      /@media \(max-height: 640px\).*?\.chat-main-panel[^}]*min-height/,
    );
    expect(premiumStyles).not.toMatch(
      /@media \(max-width: 680px\).*?\.chat-main-panel[^}]*min-height/,
    );
  });

  it('places drawers above the application chrome and below confirmation dialogs', () => {
    const drawer = zIndex(legacyStyles, '.drawer-backdrop');
    expect(drawer).toBeGreaterThan(zIndex(layoutStyles, '.app-sidebar'));
    expect(drawer).toBeLessThan(zIndex(componentStyles, '.ui-dialog-backdrop'));
  });

  it('visually hides mobile table headers without removing them from the accessibility tree', () => {
    expect(legacyStyles).not.toMatch(/@media \(max-width: 680px\).*?\.data-table thead\s*\{[^}]*display:\s*none/);
    expect(tagStyles).not.toMatch(/@media \(max-width: 680px\).*?\.tags-table thead\s*\{[^}]*display:\s*none/);
    expect(legacyStyles).toMatch(/@media \(max-width: 680px\).*?\.data-table thead\s*\{[^}]*clip:/);
    expect(tagStyles).toMatch(/@media \(max-width: 680px\).*?\.tags-table thead\s*\{[^}]*clip:/);
  });
});
