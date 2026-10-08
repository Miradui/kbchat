import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfPreview } from './PdfPreview';
import { loadPdfJs, type PdfLibrary } from './pdfjs';

vi.mock('./pdfjs', () => ({ loadPdfJs: vi.fn() }));

type PageFixture = { text: string[]; load?: Promise<void>; textReady?: Promise<void> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pdfFixture(pages: PageFixture[] = [
  { text: ['封面。费用报销须在30天内提交。'] },
  { text: ['说明。费用', '报销须在 ', '30 天内提交。', '后文。第二段可以撤销。'] },
  { text: ['第三页内容。'] },
]) {
  const renderTasks: Array<{ promise: Promise<void>; cancel: ReturnType<typeof vi.fn> }> = [];
  const layers: FixtureTextLayer[] = [];
  class FixtureTextLayer {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    cancel = vi.fn();
    container: HTMLElement;
    source: PageFixture;

    constructor({ container, textContentSource }: { container: HTMLElement; textContentSource: PageFixture }) {
      this.container = container;
      this.source = textContentSource;
      layers.push(this);
    }

    async render() {
      await this.source.textReady;
      this.textContentItemsStr = this.source.text;
      this.textDivs = this.source.text.map((text) => {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.transform = 'scaleX(1.1)';
        this.container.append(span);
        return span;
      });
    }
  }
  const getPage = vi.fn(async (number: number) => {
    const source = pages[number - 1];
    await source.load;
    return {
      userUnit: 1,
      getViewport: ({ scale }: { scale: number }) => ({ scale, width: 800 * scale, height: 1200 * scale }),
      streamTextContent: () => source,
      render: () => {
        const task = { promise: Promise.resolve(), cancel: vi.fn() };
        renderTasks.push(task);
        return task;
      },
    };
  });
  const pdf = { numPages: pages.length, getPage };
  const destroy = vi.fn().mockResolvedValue(undefined);
  const getDocument = vi.fn(() => ({ promise: Promise.resolve(pdf), destroy }));
  const library = { getDocument, TextLayer: FixtureTextLayer } as unknown as PdfLibrary;
  return { library, getDocument, getPage, layers, renderTasks, destroy };
}

const target = { id: 'chunk-1', content: '费用报销须在30天内提交。' };
const scrollTo = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

beforeEach(() => {
  vi.mocked(loadPdfJs).mockReset();
  vi.stubGlobal('ResizeObserver', undefined);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'MARK'
      ? new DOMRect(100, 600, 200, 20)
      : new DOMRect(0, 0, 640, 400);
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

async function pageText(number = 2) {
  return screen.findByRole('document', { name: `第 ${number} 页文字` });
}

function markedText(element: HTMLElement) {
  return Array.from(element.querySelectorAll('mark')).map((mark) => mark.textContent).join('');
}

describe('PdfPreview citation highlights', () => {
  it('highlights only the cited page and preserves the complete selectable text', async () => {
    const fixture = pdfFixture();
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    render(<PdfPreview filename="手册.pdf" highlight={target} initialPage={2} url="blob:authorized" />);

    const text = await pageText();
    expect(markedText(text)).toBe('费用报销须在 30 天内提交。');
    expect(text.textContent).toBe('说明。费用报销须在 30 天内提交。后文。第二段可以撤销。');
    expect(fixture.layers[0].textDivs[0].style.transform).toBe('scaleX(1.1)');
    expect(fixture.getPage).toHaveBeenCalledExactlyOnceWith(2);
    expect(fixture.getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:authorized', cMapUrl: '/pdfjs/cmaps/' }));
    expect(screen.getByText('已高亮引用内容。')).toBeInTheDocument();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 410, left: 0, behavior: 'auto' });
  });

  it('changes highlights on the same page without reloading or rendering the PDF again', async () => {
    const fixture = pdfFixture();
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const view = render(<PdfPreview filename="手册.pdf" highlight={target} initialPage={2} url="blob:authorized" />);
    await pageText();
    view.rerender(<PdfPreview filename="手册.pdf" highlight={{ id: 'chunk-2', content: '第二段可以撤销。' }} initialPage={2} url="blob:authorized" />);

    expect(markedText(await pageText())).toBe('第二段可以撤销。');
    expect(fixture.getDocument).toHaveBeenCalledTimes(1);
    expect(fixture.getPage).toHaveBeenCalledTimes(1);
    expect((await pageText()).textContent).toContain('费用报销须在 30 天内提交。');
  });

  it('returns to the citation after paging away and after selecting another citation on that page', async () => {
    const fixture = pdfFixture();
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const user = userEvent.setup();
    const view = render(<PdfPreview filename="手册.pdf" highlight={target} initialPage={2} url="blob:authorized" />);
    await pageText();
    await user.click(screen.getByRole('button', { name: 'PDF 下一页' }));
    expect((await pageText(3)).querySelector('mark')).toBeNull();
    await user.click(screen.getByRole('button', { name: '定位到引用' }));
    expect(markedText(await pageText())).toBe('费用报销须在 30 天内提交。');
    expect(screen.getByRole('button', { name: '定位到引用' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'PDF 下一页' }));
    await pageText(3);
    view.rerender(<PdfPreview filename="手册.pdf" highlight={{ id: 'chunk-2', content: '第二段可以撤销。' }} initialPage={2} url="blob:authorized" />);
    expect(markedText(await pageText())).toBe('第二段可以撤销。');
    expect(fixture.getDocument).toHaveBeenCalledTimes(1);
  });

  it('rebuilds highlights after zoom, fit-to-width, and viewport resizing', async () => {
    const fixture = pdfFixture();
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const user = userEvent.setup();
    const view = render(<PdfPreview filename="手册.pdf" highlight={target} initialPage={2} url="blob:authorized" />);
    await pageText();
    expect(view.container.querySelector('canvas')?.style.width).toBe('640px');
    await user.click(screen.getByRole('button', { name: '放大 PDF' }));
    expect(markedText(await pageText())).toBe('费用报销须在 30 天内提交。');
    expect(view.container.querySelector('canvas')?.style.width).toBe('800px');
    await user.click(screen.getByRole('button', { name: '适合宽度' }));
    await pageText();
    expect(view.container.querySelector('canvas')?.style.width).toBe('640px');

    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(480);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(markedText(await pageText())).toBe('费用报销须在 30 天内提交。');
    expect(view.container.querySelector('canvas')?.style.width).toBe('480px');
    expect(fixture.layers[0].cancel).toHaveBeenCalledTimes(1);
    expect(fixture.getDocument).toHaveBeenCalledTimes(1);
  });

  it('uses the latest same-page citation when a text layer finishes late, without stealing focus', async () => {
    const ready = deferred<void>();
    const fixture = pdfFixture([{ text: ['第一段。第二段。'], textReady: ready.promise }]);
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const user = userEvent.setup();
    const view = render(<><input aria-label="继续提问" /><PdfPreview filename="手册.pdf" highlight={{ id: 'a', content: '第一段。' }} initialPage={1} url="blob:authorized" /></>);
    await waitFor(() => expect(fixture.layers).toHaveLength(1));
    await user.click(screen.getByRole('textbox', { name: '继续提问' }));
    view.rerender(<><input aria-label="继续提问" /><PdfPreview filename="手册.pdf" highlight={{ id: 'b', content: '第二段。' }} initialPage={1} url="blob:authorized" /></>);
    await act(async () => { ready.resolve(undefined); });

    expect(markedText(await pageText(1))).toBe('第二段。');
    expect(screen.getByRole('textbox', { name: '继续提问' })).toHaveFocus();
    expect(scrollTo.mock.contexts.at(-1)).toBe(screen.getByLabelText('PDF 页面'));
    expect(fixture.getPage).toHaveBeenCalledTimes(1);
  });

  it('cancels an old page and ignores its late text layer after the citation changes pages', async () => {
    const ready = deferred<void>();
    const fixture = pdfFixture([{ text: ['旧页。'], textReady: ready.promise }, { text: ['当前页。'] }]);
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const view = render(<PdfPreview filename="手册.pdf" highlight={{ id: 'old', content: '旧页。' }} initialPage={1} url="blob:authorized" />);
    await waitFor(() => expect(fixture.layers).toHaveLength(1));
    view.rerender(<PdfPreview filename="手册.pdf" highlight={{ id: 'new', content: '当前页。' }} initialPage={2} url="blob:authorized" />);
    expect(markedText(await pageText())).toBe('当前页。');
    expect(fixture.layers[0].cancel).toHaveBeenCalledTimes(1);
    expect(fixture.renderTasks[0].cancel).toHaveBeenCalledTimes(1);
    scrollTo.mockClear();
    await act(async () => { ready.resolve(undefined); });

    expect(screen.queryByRole('document', { name: '第 1 页文字' })).not.toBeInTheDocument();
    expect(markedText(await pageText())).toBe('当前页。');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does not start rendering a page whose getPage response arrives after cancellation', async () => {
    const loading = deferred<void>();
    const fixture = pdfFixture([{ text: ['旧页。'], load: loading.promise }, { text: ['当前页。'] }]);
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const view = render(<PdfPreview filename="手册.pdf" highlight={{ id: 'old', content: '旧页。' }} initialPage={1} url="blob:authorized" />);
    await waitFor(() => expect(fixture.getPage).toHaveBeenCalledWith(1));
    view.rerender(<PdfPreview filename="手册.pdf" highlight={{ id: 'new', content: '当前页。' }} initialPage={2} url="blob:authorized" />);
    await pageText();
    await act(async () => { loading.resolve(undefined); });
    expect(fixture.layers).toHaveLength(1);
    expect(markedText(await pageText())).toBe('当前页。');
  });

  it('destroys the document and cancels unfinished drawing when the preview closes', async () => {
    const ready = deferred<void>();
    const fixture = pdfFixture([{ text: ['正文。'], textReady: ready.promise }]);
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const view = render(<PdfPreview filename="手册.pdf" highlight={{ id: 'a', content: '正文。' }} initialPage={1} url="blob:authorized" />);
    await waitFor(() => expect(fixture.layers).toHaveLength(1));
    const canvas = view.container.querySelector('canvas')!;
    view.unmount();
    expect(fixture.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.layers[0].cancel).toHaveBeenCalledTimes(1);
    expect(fixture.renderTasks[0].cancel).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    scrollTo.mockClear();
    await act(async () => { ready.resolve(undefined); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, -1, 1.5])('does not infer a highlight page from an invalid page number (%s)', async (initialPage) => {
    const fixture = pdfFixture();
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    render(<PdfPreview filename="手册.pdf" highlight={target} initialPage={initialPage} url="blob:authorized" />);
    expect((await pageText(1)).querySelector('mark')).toBeNull();
    expect(screen.getByText('引用未提供有效页码，可对照上方摘录阅读 PDF。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '定位到引用' })).not.toBeInTheDocument();
  });

  it('keeps the out-of-range notice and never highlights the fallback first page', async () => {
    const fixture = pdfFixture();
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    render(<PdfPreview filename="手册.pdf" highlight={target} initialPage={12} url="blob:authorized" />);
    expect((await pageText(1)).querySelector('mark')).toBeNull();
    expect(screen.getByText('原文共 3 页，无法定位到引用的第 12 页。已从第 1 页打开。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '定位到引用' })).toBeDisabled();
  });

  it.each<[string[], string, string]>([
    [['重复正文。重复正文。'], '重复正文。', '该页有多处相同内容，无法确定引用位置；可对照上方摘录阅读。'],
    [['不同的原文。'], '不存在的原文。', '未能在该页定位引用文字，可对照上方摘录阅读。'],
  ])('leaves ambiguous and missing excerpts unhighlighted with an explanation', async (text, content, notice) => {
    const fixture = pdfFixture([{ text }]);
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    render(<PdfPreview filename="手册.pdf" highlight={{ id: 'a', content }} initialPage={1} url="blob:authorized" />);
    expect((await pageText(1)).querySelector('mark')).toBeNull();
    expect(screen.getByText(notice)).toBeInTheDocument();
  });

  it('keeps document HTML, scripts, and image markup as literal selectable text', async () => {
    const content = '<img src="https://example.invalid/x" onerror="alert(1)"><script>alert(2)</script>';
    const fixture = pdfFixture([{ text: [`前文${content}后文`] }]);
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    render(<PdfPreview filename="手册.pdf" highlight={{ id: 'a', content }} initialPage={1} url="blob:authorized" />);
    const text = await pageText(1);
    expect(markedText(text)).toBe(content);
    expect(text.querySelector('img, script, a')).toBeNull();
  });

  it('keeps ordinary PDF reading free of citation controls and notices', async () => {
    const fixture = pdfFixture();
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    render(<PdfPreview filename="手册.pdf" initialPage={2} url="blob:authorized" />);
    expect((await pageText()).querySelector('mark')).toBeNull();
    expect(screen.queryByRole('button', { name: '定位到引用' })).not.toBeInTheDocument();
    expect(screen.queryByText(/引用未提供|已高亮|未能在该页/)).not.toBeInTheDocument();
  });

  it('retries a rendering error locally and restores the citation highlight', async () => {
    const fixture = pdfFixture();
    fixture.getPage.mockRejectedValueOnce(new Error('render failed'));
    vi.mocked(loadPdfJs).mockResolvedValue(fixture.library);
    const user = userEvent.setup();
    render(<PdfPreview filename="手册.pdf" highlight={target} initialPage={2} url="blob:authorized" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF 预览加载失败');
    await user.click(screen.getByRole('button', { name: '重试 PDF 预览' }));
    expect(markedText(await pageText())).toBe('费用报销须在 30 天内提交。');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fixture.destroy).toHaveBeenCalledTimes(1);
  });
});
