import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listGlobalDocuments } from '../../api/resources';
import type { GlobalDocumentItem } from '../../types/api';
import { ChatTaskDialog, type ChatTaskResult } from './ChatTaskDialog';

vi.mock('../../api/resources', () => ({ listGlobalDocuments: vi.fn() }));
const bases = [{ id: 'kb1', name: '行政制度' }, { id: 'kb2', name: '研发制度' }];
const documents: GlobalDocumentItem[] = [0, 1, 2].map((index) => ({
  id: `doc${index + 1}`, knowledgeBaseId: index === 1 ? 'kb2' : 'kb1', knowledgeBaseName: index === 1 ? '研发制度' : '行政制度',
  filename: index < 2 ? '报销规定.pdf' : '补充说明.pdf', fileType: 'pdf', fileSize: 100, status: 'completed', errorMessage: null, createdAt: '2026-11-23T00:00:00Z',
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listGlobalDocuments).mockResolvedValue({ items: documents, total: 3, page: 1, pageSize: 20 });
});

describe('ChatTaskDialog', () => {
  it('requires one document, supports keyboard format selection, and creates a bounded summary draft', async () => {
    const user = userEvent.setup(), onApply = vi.fn<(result: ChatTaskResult) => void>();
    render(<ChatTaskDialog kind="summary" knowledgeBases={bases} onApply={onApply} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '生成问题' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请选择 1 份文档');
    expect(screen.getByRole('button', { name: '选择资料' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '选择资料' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 报销规定.pdf（行政制度）' }));
    expect(screen.getByRole('checkbox', { name: '选择 报销规定.pdf（研发制度）' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '使用这些文档' }));
    expect(screen.getByRole('button', { name: '重新选择资料' })).toHaveFocus();
    screen.getByRole('radio', { name: '概览' }).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('radio', { name: '操作步骤' })).toBeChecked();
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '生成问题' }));
    const result = onApply.mock.calls[0][0];
    expect(result.documents?.map((document) => document.id)).toEqual(['doc1']);
    expect(result.question).toContain('报销规定.pdf');
    expect(result.question).toContain('文档编号：doc1');
    expect(result.question).toContain('输出形式：操作步骤');
    expect(result.question).toContain('责任人');
    expect(result.question).toContain('只依据本轮检索到的片段');
    expect(result.question).toContain('标注引用来源');
    expect(result.question).toContain('资料未提及');
    expect(result.question).toContain('不把局部内容表述为全文结论');
  });

  it('requires two different documents and a comparison subject, distinguishing same names', async () => {
    const user = userEvent.setup(), onApply = vi.fn<(result: ChatTaskResult) => void>();
    render(<ChatTaskDialog kind="comparison" knowledgeBases={bases} onApply={onApply} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '选择资料' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 报销规定.pdf（行政制度）' }));
    expect(screen.getByRole('button', { name: '使用这些文档' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '选择 报销规定.pdf（研发制度）' }));
    expect(screen.getByRole('checkbox', { name: '选择 补充说明.pdf（行政制度）' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '使用这些文档' }));
    expect(screen.getByText('资料 A：报销规定.pdf（行政制度）')).toBeVisible();
    expect(screen.getByText('资料 B：报销规定.pdf（研发制度）')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '生成问题' }));
    const subject = screen.getByRole('textbox', { name: '比较事项（必填）' });
    expect(subject).toHaveFocus();
    expect(subject).toHaveAttribute('aria-invalid', 'true');
    expect(subject).toHaveAccessibleDescription('请填写需要比较的事项。');
    await user.type(subject, ' 审批条件和时限 ');
    await user.keyboard('{Enter}');
    const result = onApply.mock.calls[0][0];
    expect(result.documents?.map((document) => document.id)).toEqual(['doc1', 'doc2']);
    expect(result.question).toContain('资料 A：《报销规定.pdf》（知识库：行政制度；文档编号：doc1）');
    expect(result.question).toContain('资料 B：《报销规定.pdf》（知识库：研发制度；文档编号：doc2）');
    expect(result.question).toContain('比较事项：审批条件和时限。');
    expect(result.question).toContain('某一份资料没有相关依据时单独说明');
  });

  it('keeps the confirmed selection when a replacement is cancelled and never applies on cancellation', async () => {
    const user = userEvent.setup(), onApply = vi.fn(), onClose = vi.fn();
    render(<ChatTaskDialog kind="summary" knowledgeBases={bases} onApply={onApply} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: '选择资料' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 报销规定.pdf（行政制度）' }));
    await user.click(screen.getByRole('button', { name: '使用这些文档' }));
    await user.click(screen.getByRole('button', { name: '重新选择资料' }));
    const original = await screen.findByRole('checkbox', { name: '选择 报销规定.pdf（行政制度）' });
    expect(original).toBeChecked();
    await user.click(original);
    await user.click(screen.getByRole('checkbox', { name: '选择 补充说明.pdf（行政制度）' }));
    await user.keyboard('{Escape}');
    expect(screen.getByText('报销规定.pdf（行政制度）')).toBeVisible();
    expect(screen.queryByText('补充说明.pdf（行政制度）')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新选择资料' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('requires a policy topic, preserves the caller scope, and ignores IME confirmation Enter', async () => {
    const user = userEvent.setup(), onApply = vi.fn<(result: ChatTaskResult) => void>();
    render(<ChatTaskDialog kind="policy" knowledgeBases={bases} onApply={onApply} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '生成问题' }));
    const topic = screen.getByRole('textbox', { name: '制度主题（必填）' });
    expect(topic).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('请填写要查询的制度主题');
    await user.type(topic, '差旅报销');
    expect(fireEvent.keyDown(topic, { key: 'Enter', code: 'Enter', isComposing: true })).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: '适用对象（可选）' }), '试用期员工');
    await user.keyboard('{Enter}');
    expect(onApply.mock.calls[0][0]).not.toHaveProperty('documents');
    expect(onApply.mock.calls[0][0].question).toContain('查询主题：差旅报销');
    expect(onApply.mock.calls[0][0].question).toContain('适用对象：试用期员工');
    expect(listGlobalDocuments).not.toHaveBeenCalled();
  });

  it('restores the launcher focus on Escape and traps Tab within the task dialog', async () => {
    const user = userEvent.setup(), onApply = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开任务</button>{open && <ChatTaskDialog kind="policy" knowledgeBases={bases} onApply={onApply} onClose={() => setOpen(false)} />}</>;
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开任务' }));
    expect(screen.getByRole('textbox', { name: '制度主题（必填）' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '生成问题' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '打开任务' })).toHaveFocus();
    expect(onApply).not.toHaveBeenCalled();
  });
});
