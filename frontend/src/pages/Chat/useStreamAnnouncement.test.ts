import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { derivePhase, useStreamAnnouncement } from './useStreamAnnouncement';
import type { StreamAnnouncementInput } from './useStreamAnnouncement';

const IDLE: StreamAnnouncementInput = {
  sending: false,
  streamingAnswer: '',
  streamingCitationCount: 0,
  stopped: false,
  failed: false,
};

const RETRIEVING: StreamAnnouncementInput = { ...IDLE, sending: true };
const GENERATING: StreamAnnouncementInput = { ...RETRIEVING, streamingAnswer: '员工手册规定' };

describe('derivePhase', () => {
  it('reads retrieval as the state before anything has come back', () => {
    expect(derivePhase(RETRIEVING)).toBe('retrieving');
  });

  it('treats citations arriving as generation, even before the first token', () => {
    // This is the boundary the visible UI already draws, so the announcement matches
    // what a sighted user sees change on screen.
    expect(derivePhase({ ...RETRIEVING, streamingCitationCount: 3 })).toBe('generating');
  });

  it('reads a failure as failed even while sending still looks true', () => {
    // A failure outlives the request it belongs to, so it has to win: otherwise a stale
    // `sending` would keep describing a request that has already failed.
    expect(derivePhase({ ...GENERATING, failed: true })).toBe('failed');
  });

  it('prefers a stop over the stream it stopped', () => {
    expect(derivePhase({ ...GENERATING, stopped: true })).toBe('stopped');
  });
});

describe('useStreamAnnouncement', () => {
  it('says nothing on load', () => {
    const { result } = renderHook(() => useStreamAnnouncement(IDLE));

    // A region that announces a state nobody asked about is noise on every page load.
    expect(result.current).toBe('');
  });

  it('says nothing when it mounts into a stream already in progress', () => {
    const { result } = renderHook(() => useStreamAnnouncement(GENERATING));

    // Mounting is not a transition the user caused. The effect does run on mount, so
    // without the phase-change guard this would announce the phase the moment the hook
    // appears -- on a remount, or under a strict-mode double render.
    expect(result.current).toBe('');
  });

  it('announces each phase as it is entered', () => {
    const { result, rerender } = renderHook((props: StreamAnnouncementInput) => useStreamAnnouncement(props), {
      initialProps: IDLE,
    });

    rerender(RETRIEVING);
    expect(result.current).toBe('正在检索知识库…');

    rerender(GENERATING);
    expect(result.current).toBe('正在生成回答…');

    rerender(IDLE);
    expect(result.current).toBe('回答完成');
  });

  it('does not re-announce while tokens keep arriving', () => {
    const { result, rerender } = renderHook((props: StreamAnnouncementInput) => useStreamAnnouncement(props), {
      initialProps: RETRIEVING,
    });

    rerender(GENERATING);
    const announced = result.current;
    // The whole point: content changes constantly, the phase does not, so the message
    // must be identical across token updates rather than repeating per token.
    rerender({ ...GENERATING, streamingAnswer: '员工手册规定每年' });
    rerender({ ...GENERATING, streamingAnswer: '员工手册规定每年可休' });

    expect(result.current).toBe(announced);
    expect(result.current).not.toContain('员工手册');
  });

  it('stays silent on failure so the alert is not said twice', () => {
    const { result, rerender } = renderHook((props: StreamAnnouncementInput) => useStreamAnnouncement(props), {
      initialProps: GENERATING,
    });

    rerender({ ...GENERATING, sending: false, failed: true });

    // The failure notice in the thread is a role="alert", which announces itself.
    expect(result.current).toBe('');
  });

  it('does not claim completion after a failure is dismissed', () => {
    const { result, rerender } = renderHook((props: StreamAnnouncementInput) => useStreamAnnouncement(props), {
      initialProps: GENERATING,
    });

    rerender({ ...IDLE, failed: true });
    rerender(IDLE);

    // Dismissing the failure notice also lands on idle; "回答完成" would be a lie.
    expect(result.current).toBe('');
  });

  it('announces a stop, then completion only for the next real answer', () => {
    const { result, rerender } = renderHook((props: StreamAnnouncementInput) => useStreamAnnouncement(props), {
      initialProps: GENERATING,
    });

    rerender({ ...IDLE, stopped: true });
    expect(result.current).toBe('已停止生成');

    rerender(IDLE);
    // Coming back from a stop is not a completion either.
    expect(result.current).toBe('');

    rerender(RETRIEVING);
    rerender(IDLE);
    expect(result.current).toBe('回答完成');
  });

  it('keeps the last message in place rather than clearing it', () => {
    const { result, rerender } = renderHook((props: StreamAnnouncementInput) => useStreamAnnouncement(props), {
      initialProps: RETRIEVING,
    });

    rerender(IDLE);

    // Clearing the region right after writing it can cut the announcement short, and
    // the text is invisible anyway, so there is nothing to tidy up.
    expect(result.current).toBe('回答完成');
  });

  it('announces the second question in a row', () => {
    const { result, rerender } = renderHook((props: StreamAnnouncementInput) => useStreamAnnouncement(props), {
      initialProps: IDLE,
    });

    rerender(RETRIEVING);
    rerender(IDLE);
    rerender(RETRIEVING);

    // Re-entering a phase already visited must still announce; the guard is against
    // repeating within a phase, not against ever saying the same thing twice.
    expect(result.current).toBe('正在检索知识库…');
  });
});
