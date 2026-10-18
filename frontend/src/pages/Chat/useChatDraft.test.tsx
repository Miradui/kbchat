import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chatDraftStore } from '../../store/chatDraftStore';
import { tokenStore } from '../../store/tokenStore';
import { chatDraftScope, useChatDraft } from './useChatDraft';

beforeEach(() => chatDraftStore.clearAll());
afterEach(() => { vi.restoreAllMocks(); chatDraftStore.clearAll(); });

it('restores separate drafts on session switch, account switch and remount', () => {
  const hook = renderHook(({ user, session }) => useChatDraft(user, `session:${session}`), { initialProps: { user: 'alice', session: 'a' } });
  act(() => hook.result.current.setDraft('问题 A'));
  hook.rerender({ user: 'alice', session: 'b' });
  expect(hook.result.current.draft).toBe('');
  act(() => hook.result.current.setDraft('问题 B'));
  hook.rerender({ user: 'alice', session: 'a' });
  expect(hook.result.current.draft).toBe('问题 A');
  hook.rerender({ user: 'bob', session: 'a' });
  expect(hook.result.current.draft).toBe('');
  hook.unmount();
  const restored = renderHook(() => useChatDraft('alice', 'session:b'));
  expect(restored.result.current.draft).toBe('问题 B');
});

it('transfers a new conversation draft and clears only the confirmed text', () => {
  const hook = renderHook(({ scope }) => useChatDraft('alice', scope), { initialProps: { scope: chatDraftScope(undefined, ['kb1']) } });
  act(() => hook.result.current.setDraft('  原问题  '));
  act(() => hook.result.current.moveToSession('s1'));
  hook.rerender({ scope: 'session:s1' });
  expect(hook.result.current.draft).toBe('  原问题  ');
  act(() => hook.result.current.setDraft('更新的问题'));
  act(() => hook.result.current.acknowledge('s1', '原问题'));
  expect(hook.result.current.draft).toBe('更新的问题');
  act(() => hook.result.current.acknowledge('s1', '更新的问题'));
  expect(hook.result.current.draft).toBe('');
});

it('does not let a late response clear another conversation draft', () => {
  const hook = renderHook(({ scope }) => useChatDraft('alice', scope), { initialProps: { scope: 'session:a' } });
  act(() => hook.result.current.setDraft('同一问题'));
  const accepted = hook.result.current.acknowledge;
  hook.rerender({ scope: 'session:b' });
  act(() => hook.result.current.setDraft('同一问题'));
  act(() => accepted('a', '同一问题'));
  expect(hook.result.current.draft).toBe('同一问题');
  expect(chatDraftStore.get('alice', 'session:a')).toBe('');
});

it('clears drafts on logout without clearing unrelated preferences', () => {
  localStorage.setItem('theme', 'dark');
  chatDraftStore.set('alice', 'session:a', '秘密问题');
  tokenStore.clearToken();
  expect(chatDraftStore.get('alice', 'session:a')).toBe('');
  expect(localStorage.getItem('theme')).toBe('dark');
});

it('keeps input usable when browser storage rejects writes', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  const hook = renderHook(() => useChatDraft('alice', 'session:a'));
  act(() => hook.result.current.setDraft('不会丢失的当前输入'));
  expect(hook.result.current.draft).toBe('不会丢失的当前输入');
});

it('expires old records and caps retained drafts without truncating content', () => {
  for (let i = 0; i < 55; i++) chatDraftStore.set('alice', `session:${i}`, `问题 ${i}`);
  expect(Object.keys(localStorage).filter((key) => key.startsWith('rag.chat.draft.v1:'))).toHaveLength(50);
  const recent = chatDraftStore.get('alice', 'session:54');
  expect(recent).toBe('问题 54');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86400000);
  expect(chatDraftStore.get('alice', 'session:54')).toBe('');
});

it('separates new conversation scopes and ignores deep-link UI parameters', () => {
  expect(chatDraftScope(undefined, ['a'])).not.toBe(chatDraftScope(undefined, ['b']));
  expect(chatDraftScope(undefined, [], ['doc1'])).not.toBe(chatDraftScope(undefined, [], ['doc2']));
  expect(chatDraftScope('s1', ['a'])).toBe(chatDraftScope('s1', ['b']));
});
