import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { KnowledgeBaseFormOverlay, type KnowledgeBaseFormState } from './KnowledgeBaseDrawers';

const initialForm = {
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  categoryId: '',
  visibility: 'private',
  tagIds: [],
} satisfies KnowledgeBaseFormState;

function FormHarness() {
  const [form, setForm] = useState<KnowledgeBaseFormState | null>(initialForm);
  return (
    <>
      {form && (
        <KnowledgeBaseFormOverlay
          busy={false}
          categories={[]}
          error=""
          form={form}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSubmit={(event) => event.preventDefault()}
          tags={[]}
        />
      )}
      <output aria-label="表单状态">{form ? 'open' : 'closed'}</output>
    </>
  );
}

function CreateFormHarness() {
  const [form, setForm] = useState<KnowledgeBaseFormState>({
    name: '',
    description: '',
    categoryId: '',
    visibility: 'private',
    tagIds: [],
  });
  return (
    <KnowledgeBaseFormOverlay
      busy={false}
      categories={[]}
      error=""
      form={form}
      onChange={setForm}
      onClose={() => undefined}
      onSubmit={(event) => event.preventDefault()}
      tags={[]}
    />
  );
}

describe('KnowledgeBaseFormOverlay', () => {
  it('uses the wider dialog intended for knowledge-base creation', () => {
    render(<CreateFormHarness />);

    expect(screen.getByRole('dialog', { name: '新建知识库' })).toHaveClass('kb-create-dialog');
  });

  it('owns dirty-form protection for every page that reuses it', async () => {
    const user = userEvent.setup();
    render(<FormHarness />);

    const name = screen.getByRole('textbox', { name: '名称' });
    await user.type(name, '更新');

    const unloadEvent = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unloadEvent)).toBe(false);
    expect(unloadEvent.defaultPrevented).toBe(true);

    await user.keyboard('{Escape}');
    const confirmation = screen.getByRole('dialog', { name: '放弃未保存的更改' });
    expect(screen.getByLabelText('表单状态')).toHaveTextContent('open');

    await user.click(within(confirmation).getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('制度库更新');

    await user.keyboard('{Escape}');
    await user.click(within(
      screen.getByRole('dialog', { name: '放弃未保存的更改' }),
    ).getByRole('button', { name: '放弃更改' }));
    expect(screen.getByLabelText('表单状态')).toHaveTextContent('closed');
  });
});
