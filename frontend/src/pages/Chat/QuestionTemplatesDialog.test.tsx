import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { listQuestionTemplates, saveQuestionTemplate } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import { QuestionTemplatesDialog } from './QuestionTemplatesDialog';
import { fillQuestionTemplate, questionTemplateVariables } from './questionTemplates';
vi.mock('../../api/resources', () => ({ listQuestionTemplates: vi.fn(), saveQuestionTemplate: vi.fn(), deleteQuestionTemplate: vi.fn() }));
const item = { id: 't1', title: '产品查询', body: '介绍 {{产品}}，解释 {{产品}} 的限制。', variables: ['产品'], createdAt: '', updatedAt: '' };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(listQuestionTemplates).mockResolvedValue({ items: [item], total: 1, page: 1, pageSize: 20 }); });
it('requires variable values, substitutes repeated variables literally and only inserts a draft', async () => {
  const insert = vi.fn(); const close = vi.fn();
  renderWithRouter(<QuestionTemplatesDialog draft="已有问题" onInsert={insert} onClose={close} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '使用模板' }));
  expect(screen.getByRole('button', { name: '插入草稿' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('产品'), { target: { value: '{{literal}}' } });
  await userEvent.setup().click(screen.getByRole('button', { name: '插入草稿' }));
  expect(insert).toHaveBeenCalledWith('介绍 {{literal}}，解释 {{literal}} 的限制。'); expect(close).toHaveBeenCalledOnce();
  expect(saveQuestionTemplate).not.toHaveBeenCalled();
});
it('starts from the existing draft and preserves editing on failed saves', async () => {
  vi.mocked(saveQuestionTemplate).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(item);
  renderWithRouter(<QuestionTemplatesDialog draft="请介绍 {{产品}}" onInsert={vi.fn()} onClose={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '新建模板' }));
  expect(screen.getByLabelText('模板正文')).toHaveValue('请介绍 {{产品}}');
  fireEvent.change(screen.getByLabelText('模板标题'), { target: { value: '我的模板' } });
  await userEvent.setup().click(screen.getByRole('button', { name: '保存模板' })); await screen.findByRole('alert');
  expect(screen.getByLabelText('模板标题')).toHaveValue('我的模板');
  await userEvent.setup().click(screen.getByRole('button', { name: '保存模板' }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: '提问模板' })).toBeInTheDocument());
  expect(saveQuestionTemplate).toHaveBeenLastCalledWith(null, { title: '我的模板', body: '请介绍 {{产品}}' });
});
it('rejects malformed placeholders and does not recursively substitute variable values', () => {
  expect(questionTemplateVariables('{{产品}} {{产品}} {{地区_1}}')).toEqual(['产品', '地区_1']);
  for (const body of ['{{}}', '{{a', 'a}}', '{{{{x}}}}', '{{bad name}}']) expect(questionTemplateVariables(body)).toBeNull();
  expect(fillQuestionTemplate('{{a}} {{b}}', { a: '{{b}}', b: '$&' })).toBe('{{b}} $&');
});
