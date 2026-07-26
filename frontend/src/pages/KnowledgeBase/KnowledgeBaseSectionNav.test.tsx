import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { KnowledgeBaseSectionNav } from './KnowledgeBaseSectionNav';

describe('KnowledgeBaseSectionNav', () => {
  it('exposes stable knowledge-base destinations and the current section', () => {
    render(
      <MemoryRouter>
        <KnowledgeBaseSectionNav active="settings" knowledgeBaseId="kb 1" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '概览' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb%201?tab=overview',
    );
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb%201/documents',
    );
    expect(screen.getByRole('link', { name: 'AI 问答' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb%201?tab=qa',
    );
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb%201?tab=settings',
    );
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '概览' })).not.toHaveAttribute('aria-current');
  });
});
