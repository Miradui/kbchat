import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';

import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { loadPdfJs, type PdfLibrary } from './pdfjs';

type PdfPreviewProps = {
  url: string;
  filename: string;
  initialPage?: number | null;
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
export function PdfPreview({ url, filename, initialPage }: PdfPreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [failure, setFailure] = useState<{ url: string; attempt: number; message: string } | null>(null);
  const requestedPage = Number.isInteger(initialPage) && Number(initialPage) > 0 ? Number(initialPage) : 1;
  const [navigation, setNavigation] = useState({ requestedPage, page: requestedPage });
  const [zoom, setZoom] = useState(1);
  const current = loaded?.url === url && loaded.attempt === attempt ? loaded : null;
  const error = failure?.url === url && failure.attempt === attempt ? failure.message : '';
  const selectedPage = navigation.requestedPage === requestedPage ? navigation.page : requestedPage;
  const page = current && selectedPage <= current.pdf.numPages ? selectedPage : 1;

  useEffect(() => {
    setNavigation({ requestedPage, page: requestedPage });
  }, [url, requestedPage]);

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
    setNavigation({ requestedPage, page: nextPage });
    viewportRef.current?.scrollTo?.({ top: 0, left: 0 });
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
        </div>
      </div>
      <p aria-live="polite" className="sr-only" role="status">{error ? '' : current ? `PDF 共 ${current.pdf.numPages} 页，当前第 ${page} 页。` : '正在加载 PDF 原文…'}</p>
      {current && requestedPage > current.pdf.numPages && (
        <p className="pdf-preview__notice">原文共 {current.pdf.numPages} 页，无法定位到引用的第 {requestedPage} 页。已从第 1 页打开。</p>
      )}
      <div aria-label="PDF 页面" className="pdf-preview__viewport" ref={viewportRef} tabIndex={0}>
        {error ? <PdfError message={error} onRetry={retry} /> : current && width > 0 ? (
          <PdfPage
            key={`${url}:${attempt}:${page}:${width}:${zoom}`}
            library={current.library}
            onRetry={retry}
            pageNumber={page}
            pdf={current.pdf}
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

function PdfPage({ pdf, library, pageNumber, width, zoom, onRetry }: {
  pdf: PDFDocumentProxy;
  library: PdfLibrary;
  pageNumber: number;
  width: number;
  zoom: number;
  onRetry: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

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
      if (active) setPhase('ready');
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

  return (
    <div aria-busy={phase === 'loading' || undefined}>
      {phase === 'loading' && <p className="pdf-preview__notice">正在显示第 {pageNumber} 页…</p>}
      {phase === 'error' && <PdfError message={error} onRetry={onRetry} />}
      <div className="pdf-preview__page" hidden={phase !== 'ready'} ref={pageRef}>
        <canvas aria-hidden="true" ref={canvasRef} />
        <div aria-label={`第 ${pageNumber} 页文字`} className="pdf-preview__text-layer" ref={textRef} role="document" />
      </div>
    </div>
  );
}
