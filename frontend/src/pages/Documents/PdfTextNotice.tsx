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
  if (!summary || summary.pagesWithoutText.length === 0) return null;
  const pages = <p className="doc-detail__pdf-pages">未提取页码：{pageRanges(summary.pagesWithoutText)}。</p>;
  return (
    <div aria-label="PDF 文字提取情况" className="ui-inline-notice doc-detail__pdf-text" role="note">
      <p>共 {summary.totalPages} 页，其中 {summary.pagesWithoutText.length} 页未提取到文字。</p>
      {summary.pagesWithoutText.length > 20 ? <details><summary>查看全部页码</summary>{pages}</details> : pages}
      <p className="ui-muted">这些页未纳入检索，可能是空白页或扫描图片，请核对原文件。</p>
    </div>
  );
}
