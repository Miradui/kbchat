import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { Citation } from '../../types/api';
import { CitationCard } from './ChatMessage';

/**
 * A citation filename is clipped to one line, so the full value has to stay reachable:
 * screen readers get it from the card's `aria-label` and the link's, pointer users get
 * it from `title`. Losing one of those makes a long filename unreadable for that group
 * without anything looking broken.
 */
const LONG_NAME = '2026年度员工手册-修订版-含附件与变更记录-最终.pdf';

/* `satisfies`, not a cast: a cast let an earlier version of this fixture omit
   `vectorScore`, which the card formats, and the failure surfaced inside toFixed. */
const citation = {
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  filename: LONG_NAME,
  content: '引用正文',
  pageNumber: 12,
  vectorScore: 0.82,
  rerankScore: 0.9,
} satisfies Citation;

function renderCard(props: Partial<Parameters<typeof CitationCard>[0]> = {}) {
  render(
    <MemoryRouter>
      <CitationCard citation={citation} focused={false} index={1} knowledgeBaseId="kb-1" {...props} />
    </MemoryRouter>,
  );
}

describe('CitationCard long filenames', () => {
  it('keeps the full filename readable on hover when it is clipped', () => {
    renderCard();

    expect(screen.getByTitle(LONG_NAME)).toHaveTextContent(LONG_NAME);
  });

  it('keeps the hover affordance when there is no link to open', () => {
    // Without a knowledge base there is no link, so the link's own aria-label is gone
    // too -- the title is the only thing left carrying the full name to a mouse user.
    renderCard({ knowledgeBaseId: undefined });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByTitle(LONG_NAME)).toBeInTheDocument();
  });

  it('announces the full filename regardless of clipping', () => {
    renderCard();

    expect(screen.getByRole('article', { name: `来源 1：${LONG_NAME}` })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `打开来源：${LONG_NAME}，p.12` })).toBeInTheDocument();
  });

  it('never drops the page label, however long the filename is', () => {
    renderCard();

    // The label is `flex: 0 0 auto`, so it is not squeezed out by the name beside it.
    expect(screen.getByText('p.12')).toBeInTheDocument();
  });

  it('says so explicitly when a citation has no page number', () => {
    renderCard({ citation: { ...citation, pageNumber: null } });

    // Not an empty slot: "no page number" is information about the source.
    expect(screen.getByText('无页码')).toBeInTheDocument();
  });
});
