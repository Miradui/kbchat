import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../components/feedback/ToastProvider';
import { router } from '../../router';
import { currentUserStore } from '../../store/currentUserStore';
import { queryClient } from '../../store/queryClient';
import { defaultSystemCapabilities, systemCapabilitiesStore } from '../../store/systemCapabilitiesStore';
import { tokenStore } from '../../store/tokenStore';
import fixture from '../../test/fixtures/answer-prompt/knowledge-base.json';
import qualityFixture from '../../test/fixtures/answer-prompt/quality.json';
import type { KnowledgeBase } from '../../types/api';

let knowledgeBase: KnowledgeBase;
let writes: Partial<KnowledgeBase>[];
let unexpectedRequests: string[];
let failSave: boolean;
let saveGate: Promise<void> | null;
let workflowRouter: ReturnType<typeof createMemoryRouter>;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

beforeEach(() => {
  knowledgeBase = structuredClone(fixture) as KnowledgeBase;
  writes = [];
  unexpectedRequests = [];
  failSave = false;
  saveGate = null;
  currentUserStore.clear();
  systemCapabilitiesStore.clear();
  tokenStore.setToken('local-fixture-token');
  // jsdom has no scrolling implementation; this is a browser-driver boundary.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  // Only the external HTTP transport is replaced; pages, routing, stores and API clients stay real.
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/auth/me') {
      return Response.json({ id: 'fixture-user', username: 'fixture', displayName: '测试员工', role: 'user', status: 'active' });
    }
    if (path === '/api/v1/system/capabilities') {
      return Response.json({ ...defaultSystemCapabilities, rerankEnabled: true, chatModels: ['fixture-chat'] });
    }
    if (path === `/api/v1/knowledge-bases/${fixture.id}`) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Partial<KnowledgeBase>;
        writes.push(body);
        if (failSave) return Response.json({ code: 'INTERNAL_ERROR', message: '夹具保存失败' }, { status: 503 });
        if (saveGate) await saveGate;
        knowledgeBase = { ...knowledgeBase, ...body };
      }
      return Response.json(knowledgeBase);
    }
    if (path === `/api/v1/knowledge-bases/${fixture.id}/view` && method === 'POST') return new Response(null, { status: 204 });
    if (path === '/api/v1/knowledge-bases') return Response.json({ items: [knowledgeBase], total: 1, page: 1, pageSize: 100 });
    if (path === '/api/v1/chat/sessions') return Response.json({ items: [], total: 0, page: 1, pageSize: 50 });
    if (method === 'GET' && (path === `/api/v1/knowledge-bases/${fixture.id}/evaluation-cases` || path === `/api/v1/knowledge-bases/${fixture.id}/evaluation-runs`)) return Response.json({ items: [] });
    for (const [endpoint, response] of Object.entries(qualityFixture)) {
      if (method === 'GET' && path === `/api/v1/chat/quality/${endpoint}`) return Response.json(response);
    }
    unexpectedRequests.push(`${method} ${path}`);
    return Response.json({ code: 'RESOURCE_NOT_FOUND', message: '未配置此夹具请求' }, { status: 404 });
  });
});

afterEach(() => {
  cleanup();
  workflowRouter?.dispose();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.unstubAllGlobals();
});

function openSettings() {
  workflowRouter = createMemoryRouter(router.routes, { initialEntries: [`/knowledge-bases/${fixture.id}/settings`] });
  render(<QueryClientProvider client={queryClient}><ToastProvider><RouterProvider router={workflowRouter} /></ToastProvider></QueryClientProvider>);
}

function recordResult(name: string, result: Record<string, boolean | number | string>) {
  const directory = resolve('src/test/fixtures/answer-prompt/runs/latest');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
}

it('chooses and edits templates, preserves failed saves, then opens a saved single-base chat through production routes', async () => {
  const actor = userEvent.setup();
  openSettings();
  const editor = await screen.findByRole('textbox', { name: '知识库回答提示词' }, { timeout: 10000 });
  const form = within(editor.closest('form')!);
  const selector = form.getByRole('combobox', { name: '内置模板' }) as HTMLSelectElement;
  const templateIds = Array.from(selector.options).map((option) => option.value).filter(Boolean);
  expect(templateIds).toHaveLength(5);
  const initialPrompt = (editor as HTMLTextAreaElement).value;

  await actor.selectOptions(selector, templateIds[0]);
  await actor.click(screen.getByRole('button', { name: '取消' }));
  expect(editor).toHaveValue(initialPrompt);
  expect(writes).toHaveLength(0);

  for (const id of templateIds) {
    const previous = (editor as HTMLTextAreaElement).value;
    await actor.selectOptions(selector, id);
    const dialog = await screen.findByRole('dialog');
    const preview = within(dialog).getByRole('region').textContent;
    expect(preview?.length).toBeGreaterThan(0);
    expect(editor).toHaveValue(previous);
    await actor.click(screen.getByRole('button', { name: '替换提示词' }));
    expect(editor).toHaveValue(preview);
    expect((editor as HTMLTextAreaElement).value).not.toBe(previous);
    expect((editor as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
    expect((editor as HTMLTextAreaElement).value.length).toBeLessThanOrEqual(2000);
  }
  await actor.type(editor, '\n请优先解释员工需要做什么。');
  const editedPrompt = (editor as HTMLTextAreaElement).value;
  expect(form.getByRole('button', { name: '在本库试问' })).toBeDisabled();

  failSave = true;
  await actor.click(form.getByRole('button', { name: '保存配置' }));
  await screen.findByRole('alert');
  expect(editor).toHaveValue(editedPrompt);
  expect(knowledgeBase.answerConfig.systemPromptAddition).toBe(initialPrompt);
  expect(form.getByRole('button', { name: '在本库试问' })).toBeDisabled();

  failSave = false;
  let releaseSave!: () => void;
  saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await actor.click(form.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(selector).toBeDisabled();
  expect(editor).toBeDisabled();
  expect(form.getByRole('button', { name: '在本库试问' })).toBeDisabled();
  await act(async () => releaseSave());
  await waitFor(() => expect(form.getByRole('button', { name: '在本库试问' })).toBeEnabled());
  expect(knowledgeBase.answerConfig).toEqual({ ...fixture.answerConfig, systemPromptAddition: editedPrompt });
  expect(knowledgeBase.retrievalConfig).toEqual(fixture.retrievalConfig);

  await actor.click(form.getByRole('button', { name: '在本库试问' }));
  const composer = await screen.findByRole('textbox', { name: '输入问题' }, { timeout: 10000 });
  await waitFor(() => expect(composer).toBeEnabled());
  expect(workflowRouter.state.location.pathname).toBe('/chat');
  expect(workflowRouter.state.location.search).toBe(`?knowledgeBaseId=${fixture.id}`);
  await act(async () => { await workflowRouter.navigate(-1); });
  expect(await screen.findByRole('textbox', { name: '知识库回答提示词' })).toHaveValue(editedPrompt);
  expect(unexpectedRequests).toEqual([]);
  recordResult('edit-save-trial', { templateCount: templateIds.length, previewMatchedAppliedContent: true, cancelPreservedContent: true, failedSavePreservedContent: true, savingBlockedEdits: true, retainedOtherSettings: true, trialScope: 'manual-single', reloadedSavedPrompt: true });
}, 15000);

it('fills an empty prompt directly and resets to the saved value without making an HTTP write', async () => {
  knowledgeBase.answerConfig.systemPromptAddition = '';
  openSettings();
  const actor = userEvent.setup();
  const editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  const form = within(editor.closest('form')!);
  await actor.selectOptions(form.getByRole('combobox', { name: '内置模板' }), 'general');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect((editor as HTMLTextAreaElement).value).not.toBe('');
  expect(form.getByRole('button', { name: '在本库试问' })).toBeDisabled();
  await actor.click(form.getByRole('button', { name: '重置' }));
  expect(editor).toHaveValue('');
  expect(form.getByRole('button', { name: '在本库试问' })).toBeEnabled();
  expect(writes).toHaveLength(0);
  expect(unexpectedRequests).toEqual([]);
  recordResult('empty-reset', { filledWithoutConfirmation: true, resetRestoredSavedPrompt: true, httpWrites: writes.length });
});

it('keeps templates and prompts read-only for a viewer while allowing an authorized single-base trial', async () => {
  knowledgeBase.capabilities = ['chat.use', 'document.read'];
  knowledgeBase.effectiveRole = 'viewer';
  openSettings();
  const actor = userEvent.setup();
  const editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  const form = within(editor.closest('form')!);
  expect(editor).toBeDisabled();
  expect(form.getByRole('combobox', { name: '内置模板' })).toBeDisabled();
  expect(form.queryByRole('button', { name: '保存配置' })).not.toBeInTheDocument();
  expect(form.queryByRole('button', { name: '保存并试问' })).not.toBeInTheDocument();
  expect(form.queryByRole('link', { name: '去回归评测对比效果' })).not.toBeInTheDocument();
  await actor.click(form.getByRole('button', { name: '在本库试问' }));
  const composer = await screen.findByRole('textbox', { name: '输入问题' }, { timeout: 10000 });
  await waitFor(() => expect(composer).toBeEnabled());
  expect(workflowRouter.state.location.search).toBe(`?knowledgeBaseId=${fixture.id}`);
  expect(writes).toHaveLength(0);
  expect(unexpectedRequests).toEqual([]);
  recordResult('viewer-trial', { promptReadOnly: true, templateReadOnly: true, trialScope: 'manual-single', httpWrites: writes.length });
});

it('protects edits on reload, header navigation and browser back, then opens this base in evaluation', async () => {
  knowledgeBase.capabilities!.push('quality.read');
  openSettings();
  const actor = userEvent.setup();
  let editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  const reloadBlocked = () => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  expect(reloadBlocked()).toBe(false);
  await actor.type(editor, '请列出办理步骤。');
  const draft = (editor as HTMLTextAreaElement).value;
  expect(reloadBlocked()).toBe(true);
  await actor.click(screen.getByRole('button', { name: '基于此知识库提问' }));
  await screen.findByRole('dialog', { name: '放弃未保存的修改？' });
  expect(workflowRouter.state.location.pathname).toContain('/settings');
  await actor.keyboard('{Escape}');
  expect(editor).toHaveValue(draft);
  await actor.click(screen.getByRole('link', { name: '去回归评测对比效果' }));
  await actor.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(editor).toHaveValue(draft);
  await actor.click(within(editor.closest('form')!).getByRole('button', { name: '重置' }));
  expect(reloadBlocked()).toBe(false);
  await actor.click(screen.getByRole('button', { name: '基于此知识库提问' }));
  await screen.findByRole('textbox', { name: '输入问题' });
  await act(async () => { await workflowRouter.navigate(-1); });
  editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  await actor.type(editor, '待丢弃的草稿');
  await actor.click(screen.getByRole('link', { name: '去回归评测对比效果' }));
  await act(async () => { await actor.click(screen.getByRole('button', { name: '放弃并离开' })); });
  await screen.findByRole('button', { name: '新增测试问题' });
  expect(workflowRouter.state.location.pathname).toBe('/quality');
  expect(new URLSearchParams(workflowRouter.state.location.search).get('knowledgeBaseId')).toBe(fixture.id);
  expect(new URLSearchParams(workflowRouter.state.location.search).get('tab')).toBe('evaluation');
  expect(knowledgeBase.answerConfig.systemPromptAddition).toBe(fixture.answerConfig.systemPromptAddition);
  await act(async () => { await workflowRouter.navigate(`/knowledge-bases/${fixture.id}/settings`); });
  editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  await actor.type(editor, '返回前的草稿');
  await act(async () => { await workflowRouter.navigate(-1); });
  await actor.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(editor).toHaveValue(`${fixture.answerConfig.systemPromptAddition}返回前的草稿`);
  await act(async () => { await workflowRouter.navigate(-1); });
  await actor.click(screen.getByRole('button', { name: '放弃并离开' }));
  await screen.findByRole('button', { name: '新增测试问题' });
  expect(reloadBlocked()).toBe(false);
  expect(writes).toHaveLength(0);
  expect(unexpectedRequests).toEqual([]);
  recordResult('unsaved-navigation', { reloadProtected: true, resetRemovedProtection: true, headerNavigationProtected: true, backProtected: true, cancelPreservedDraft: true, discardKeptSavedValue: true, evaluationScope: 'manual-single', httpWrites: writes.length });
}, 15000);

it('saves before a trial, keeps failed input, and blocks edits and duplicate saves while the request is pending', async () => {
  openSettings();
  const actor = userEvent.setup();
  const editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  const form = within(editor.closest('form')!);
  const trial = form.getByRole('button', { name: '保存并试问' });
  expect(trial).toBeDisabled();
  await actor.type(editor, '请列出材料。');
  const draft = (editor as HTMLTextAreaElement).value;
  failSave = true;
  await actor.click(trial);
  await screen.findByRole('alert');
  expect(editor).toHaveValue(draft);
  expect(workflowRouter.state.location.pathname).toContain('/settings');
  expect(knowledgeBase.answerConfig).toEqual(fixture.answerConfig);
  failSave = false;
  let releaseSave!: () => void;
  saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await actor.click(trial);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(trial).toBeDisabled();
  expect(form.getByRole('button', { name: '保存中' })).toBeDisabled();
  expect(editor).toBeDisabled();
  expect(form.getByRole('combobox', { name: '内置模板' })).toBeDisabled();
  expect(form.getByRole('button', { name: '在本库试问' })).toBeDisabled();
  await actor.click(trial);
  expect(writes).toHaveLength(2);
  await act(async () => releaseSave());
  const composer = await screen.findByRole('textbox', { name: '输入问题' });
  await waitFor(() => expect(composer).toBeEnabled());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(workflowRouter.state.location.search).toBe(`?knowledgeBaseId=${fixture.id}`);
  expect(knowledgeBase.answerConfig.systemPromptAddition).toBe(draft);
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  await act(async () => { await workflowRouter.navigate(-1); });
  expect(await screen.findByRole('textbox', { name: '知识库回答提示词' })).toHaveValue(draft);
  expect(unexpectedRequests).toEqual([]);
  recordResult('save-and-trial', { failureStayedOnForm: true, failurePreservedDraft: true, pendingDisabledActions: true, saveRequests: writes.length, savedBeforeTrial: true, trialScope: 'manual-single', reloadedSavedPrompt: true });
});

it('allows saving without chat permission but disables both trial actions', async () => {
  knowledgeBase.capabilities = ['kb.write', 'document.read'];
  openSettings();
  const actor = userEvent.setup();
  const editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  const form = within(editor.closest('form')!);
  await actor.type(editor, '仅编辑。');
  expect(form.getByRole('button', { name: '保存并试问' })).toBeDisabled();
  await actor.click(form.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(form.getByRole('button', { name: '保存配置' })).toBeDisabled());
  expect(form.getByRole('button', { name: '在本库试问' })).toBeDisabled();
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  expect(writes).toHaveLength(1);
  expect(unexpectedRequests).toEqual([]);
  recordResult('no-chat-permission', { saveAllowed: true, trialDisabled: true, saveAndTrialDisabled: true, savedRemovedProtection: true });
});

it('waits for an in-flight save before completing a requested navigation', async () => {
  openSettings();
  const actor = userEvent.setup();
  const editor = await screen.findByRole('textbox', { name: '知识库回答提示词' });
  await actor.type(editor, '保存时等待。');
  const draft = (editor as HTMLTextAreaElement).value;
  let releaseSave!: () => void;
  saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await actor.click(within(editor.closest('form')!).getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await actor.click(screen.getByRole('button', { name: '基于此知识库提问' }));
  expect(screen.getByRole('button', { name: '继续编辑' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '处理中' })).toBeDisabled();
  await actor.keyboard('{Escape}');
  expect(workflowRouter.state.location.pathname).toContain('/settings');
  await act(async () => releaseSave());
  const composer = await screen.findByRole('textbox', { name: '输入问题' });
  await waitFor(() => expect(composer).toBeEnabled());
  expect(knowledgeBase.answerConfig.systemPromptAddition).toBe(draft);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(unexpectedRequests).toEqual([]);
  recordResult('navigation-during-save', { navigationWaitedForSave: true, savedBeforeNavigation: true, saveRequests: writes.length });
});
