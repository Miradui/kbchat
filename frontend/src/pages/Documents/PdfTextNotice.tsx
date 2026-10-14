import type { PdfTextSummary } from '../../types/api';

function pageRanges(pages: number[]): string {
  const ranges: string[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const start = pages[index];
    let end = start;
    while (pages[index + 1] === end + 1) end = pages[++index];
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join('、');
}

export function PdfTextNotice({ summary }: { summary?: PdfTextSummary | null }) {
  if (!summary || (summary.pagesWithoutText.length === 0 && !summary.ocr)) return null;
  const ocr = summary.ocr;
  const pages = <p className="doc-detail__pdf-pages">未提取页码：{pageRanges(summary.pagesWithoutText)}。</p>;
  return (
    <div aria-label="PDF 文字提取情况" className="ui-inline-notice doc-detail__pdf-text" role="note">
      <p>共 {summary.totalPages} 页，其中 {summary.pagesWithoutText.length} 页未提取到文字。</p>
      {summary.pagesWithoutText.length > 0 && (summary.pagesWithoutText.length > 20 ? <details><summary>查看全部页码</summary>{pages}</details> : pages)}
      {ocr?.status === 'running' && <p role="status">正在进行 OCR，已识别 {ocr.completedPages} / {ocr.totalPages} 页。</p>}
      {ocr && ocr.pages.length > 0 && <p>OCR 提取文字的页码：{pageRanges(ocr.pages)}。识别文本可在内容片段中查看，请对照原图核实。</p>}
      {ocr?.status === 'disabled' && <p className="ui-muted">服务器尚未启用扫描 PDF 识别；管理员启用 OCR 后可重新处理。</p>}
      {ocr && ['unavailable', 'timeout', 'failed', 'limit_exceeded'].includes(ocr.status) && <p className="ui-muted">本次 OCR 未完成，识别结果尚未发布；如有旧片段仍保留。请按失败提示处理后重试。</p>}
      {summary.pagesWithoutText.length > 0 && <p className="ui-muted">这些页未纳入本次识别文本，可能是空白页或扫描图片，请核对原文件。</p>}
      {ocr?.status === 'completed' && <p className="ui-muted">OCR 已完成。文档处理成功后，识别文本即可用于问答。扫描页仅定位到页，不显示文字高亮。</p>}
    </div>
  );
}
