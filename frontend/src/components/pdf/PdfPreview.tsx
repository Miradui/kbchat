import { ChevronLeft, ChevronRight, LocateFixed, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';

import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { matchPdfCitation } from './pdfCitation';
import { loadPdfJs, type PdfLibrary } from './pdfjs';

export type PdfHighlightTarget = { id: string; content: string };

type PdfPreviewProps = {
  url: string;
  filename: string;
  initialPage?: number | null;
  highlight?: PdfHighlightTarget;
};

type LoadedPdf = { url: string; attempt: number; pdf: PDFDocumentProxy; library: PdfLibrary };

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_SIDE = 8192;

function pdfErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'PasswordException') return '此 PDF 需要密码，请下载原文件后使用 PDF 阅读器打开。';
  if (name === 'InvalidPDFException') return 'PDF 文件无法解析，可能已损坏。请重新上传完整文件。';
  return 'PDF 预览加载失败，请重试或下载原文件查看。';
}

/** Renders the already-authorized blob; it never fetches a document API itself. */
export function PdfPreview({ url, filename, initialPage, highlight }: PdfPreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [failure, setFailure] = useState<{ url: string; attempt: number; message: string } | null>(null);
  const citationPage = Number.isInteger(initialPage) && Number(initialPage) > 0 ? Number(initialPage) : null;
  const requestedPage = citationPage ?? 1;
  const selection = JSON.stringify([url, requestedPage, highlight?.id]);
  const [navigation, setNavigation] = useState({ selection, page: requestedPage });
  const [locateRequest, setLocateRequest] = useState(0);
  const [zoom, setZoom] = useState(1);
  const current = loaded?.url === url && loaded.attempt === attempt ? loaded : null;
  const error = failure?.url === url && failure.attempt === attempt ? failure.message : '';
  const selectedPage = navigation.selection === selection ? navigation.page : requestedPage;
  const page = current && selectedPage <= current.pdf.numPages ? selectedPage : 1;
  const validCitationPage = citationPage !== null && current !== null && citationPage <= current.pdf.numPages;

  useEffect(() => {
    setNavigation({ selection, page: requestedPage });
  }, [selection, requestedPage]);

  useEffect(() => {
    setZoom(1);
  }, [url]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setLoaded(null);
    setFailure(null);
    void loadPdfJs().then(async (library) => {
      if (!active) return;
      const assets = `${import.meta.env.BASE_URL}pdfjs/`;
      task = library.getDocument({
        url,
        cMapUrl: `${assets}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`,
        wasmUrl: `${assets}wasm/`,
        iccUrl: `${assets}iccs/`,
        stopAtErrors: true,
      });
      const pdf = await task.promise;
      if (active) setLoaded({ url, attempt, pdf, library });
    }).catch((caught: unknown) => {
      if (active) setFailure({ url, attempt, message: pdfErrorMessage(caught) });
    });
    return () => {
      active = false;
      void task?.destroy().catch(() => undefined);
    };
  }, [url, attempt]);

  const retry = () => setAttempt((value) => value + 1);
  const move = (nextPage: number) => {
    setNavigation({ selection, page: nextPage });
    viewportRef.current?.scrollTo?.({ top: 0, left: 0 });
  };
  const locate = () => {
    setNavigation({ selection, page: requestedPage });
    setLocateRequest((value) => value + 1);
  };

  return (
    <section aria-label={`PDF 原文：${filename}`} className="pdf-preview">
      <div aria-label="PDF 阅读控制" className="pdf-preview__toolbar">
        <div className="pdf-preview__controls">
          <IconButton disabled={!current || page <= 1} label="PDF 上一页" onClick={() => move(page - 1)}><ChevronLeft aria-hidden="true" /></IconButton>
          <span className="pdf-preview__page-count">{current ? `第 ${page} / ${current.pdf.numPages} 页` : 'PDF'}</span>
          <IconButton disabled={!current || page >= current.pdf.numPages} label="PDF 下一页" onClick={() => move(page + 1)}><ChevronRight aria-hidden="true" /></IconButton>
        </div>
        <div className="pdf-preview__controls">
          <IconButton disabled={!current || zoom <= MIN_ZOOM} label="缩小 PDF" onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}><ZoomOut aria-hidden="true" /></IconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <IconButton disabled={!current || zoom >= MAX_ZOOM} label="放大 PDF" onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}><ZoomIn aria-hidden="true" /></IconButton>
          <Button disabled={!current || zoom === 1} onClick={() => setZoom(1)} variant="ghost">适合宽度</Button>
          {highlight && citationPage !== null && (
            <Button disabled={!validCitationPage} leadingIcon={<LocateFixed aria-hidden="true" />} onClick={locate} variant="ghost">定位到引用</Button>
          )}
        </div>
      </div>
      <p aria-live="polite" className="sr-only" role="status">{error ? '' : current ? `PDF 共 ${current.pdf.numPages} 页，当前第 ${page} 页。` : '正在加载 PDF 原文…'}</p>
      {current && requestedPage > current.pdf.numPages && (
        <p className="pdf-preview__notice">原文共 {current.pdf.numPages} 页，无法定位到引用的第 {requestedPage} 页。已从第 1 页打开。</p>
      )}
      {highlight && citationPage === null && (
        <p className="pdf-preview__notice">引用未提供有效页码，可对照上方摘录阅读 PDF。</p>
      )}
      <div aria-label="PDF 页面" className="pdf-preview__viewport" ref={viewportRef} tabIndex={0}>
        {error ? <PdfError message={error} onRetry={retry} /> : current && width > 0 ? (
          <PdfPage
            key={`${url}:${attempt}:${page}:${width}:${zoom}`}
            highlight={validCitationPage && page === citationPage ? highlight : undefined}
            library={current.library}
            locateRequest={locateRequest}
            onRetry={retry}
            pageNumber={page}
            pdf={current.pdf}
            viewportRef={viewportRef}
            width={width}
            zoom={zoom}
          />
        ) : <p className="pdf-preview__notice">正在加载 PDF 原文…</p>}
      </div>
    </section>
  );
}

function PdfError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="pdf-preview__notice"><p className="ui-inline-error" role="alert">{message}</p><Button onClick={onRetry} variant="secondary">重试 PDF 预览</Button></div>;
}

function PdfPage({ pdf, library, pageNumber, width, zoom, onRetry, highlight, locateRequest, viewportRef }: {
  pdf: PDFDocumentProxy;
  library: PdfLibrary;
  pageNumber: number;
  width: number;
  zoom: number;
  onRetry: () => void;
  highlight?: PdfHighlightTarget;
  locateRequest: number;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [renderedLayer, setRenderedLayer] = useState<TextLayer | null>(null);
  const highlightId = highlight?.id;
  const highlightContent = highlight?.content;
  const match = useMemo(() => renderedLayer && highlightContent !== undefined
    ? matchPdfCitation(renderedLayer.textContentItemsStr, highlightContent)
    : null, [renderedLayer, highlightContent]);

  useEffect(() => {
    let active = true;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const canvas = canvasRef.current;
    const pageElement = pageRef.current;
    const textElement = textRef.current;
    if (!canvas || !pageElement || !textElement) return;

    void (async () => {
      const pdfPage = await pdf.getPage(pageNumber);
      if (!active) return;
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: (width / unscaled.width) * zoom });
      const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
        MAX_CANVAS_SIDE / viewport.width,
        MAX_CANVAS_SIDE / viewport.height,
      );
      canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pageElement.style.width = `${viewport.width}px`;
      pageElement.style.height = `${viewport.height}px`;
      textElement.style.setProperty('--total-scale-factor', String(viewport.scale * pdfPage.userUnit));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      renderTask = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      // This is a text layer for selection and accessibility, not PDF scripting
      // or an interactive annotation/form layer.
      textLayer = new library.TextLayer({ container: textElement, viewport, textContentSource: pdfPage.streamTextContent() });
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (active) {
        setRenderedLayer(textLayer);
        setPhase('ready');
      }
    })().catch((caught: unknown) => {
      if (active) {
        setError(pdfErrorMessage(caught));
        setPhase('error');
      }
    });

    return () => {
      active = false;
      renderTask?.cancel();
      textLayer?.cancel();
      canvas.width = canvas.height = 0;
    };
  }, [pdf, library, pageNumber, width, zoom]);

  useLayoutEffect(() => {
    if (!renderedLayer || !match) return;
    const restore: (() => void)[] = [];
    let firstMark: HTMLElement | null = null;
    if (match.status === 'matched') {
      for (const { itemIndex, start, end } of match.ranges) {
        const element = renderedLayer.textDivs[itemIndex];
        const text = renderedLayer.textContentItemsStr[itemIndex];
        const mark = document.createElement('mark');
        mark.className = 'pdf-preview__highlight';
        mark.textContent = text.slice(start, end);
        // Keep PDF.js's positioned span intact. Only its plain text is split,
        // so rotation, zoom, selection, and literal HTML stay unchanged.
        element.replaceChildren(text.slice(0, start), mark, text.slice(end));
        firstMark ??= mark;
        restore.push(() => { element.textContent = text; });
      }
    }
    // Scroll only this viewer, after its text layer is visible. A late PDF
    // must not move focus or scroll the surrounding conversation.
    const viewport = viewportRef.current;
    if (viewport) {
      const container = viewport.getBoundingClientRect();
      const target = firstMark?.getBoundingClientRect();
      viewport.scrollTo?.({
        top: target ? Math.max(0, viewport.scrollTop + target.top - container.top - (viewport.clientHeight - Math.min(target.height, viewport.clientHeight)) / 2) : 0,
        left: target ? Math.max(0, viewport.scrollLeft + target.left - container.left - (viewport.clientWidth - Math.min(target.width, viewport.clientWidth)) / 2) : 0,
        behavior: 'auto',
      });
    }
    return () => { restore.forEach((reset) => reset()); };
  }, [renderedLayer, match, highlightId, locateRequest, viewportRef]);

  return (
    <div aria-busy={phase === 'loading' || undefined}>
      {phase === 'loading' && <p className="pdf-preview__notice">正在显示第 {pageNumber} 页…</p>}
      {phase === 'error' && <PdfError message={error} onRetry={onRetry} />}
      {match && <p className="pdf-preview__notice" role="status">{match.status === 'matched' ? '已高亮引用内容。'
        : match.status === 'ambiguous' ? '该页有多处相同内容，无法确定引用位置；可对照上方摘录阅读。'
          : '未能在该页定位引用文字，可对照上方摘录阅读。'}</p>}
      <div className="pdf-preview__page" hidden={phase !== 'ready'} ref={pageRef}>
        <canvas aria-hidden="true" ref={canvasRef} />
        <div aria-label={`第 ${pageNumber} 页文字`} className="pdf-preview__text-layer" ref={textRef} role="document" />
      </div>
    </div>
  );
}
