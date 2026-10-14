import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PdfTextNotice } from './PdfTextNotice';

describe('PDF text extraction notice', () => {
  it('shows recognized page ranges and remaining blanks without claiming image highlighting', () => {
    render(<PdfTextNotice summary={{ totalPages: 4, textPages: 3, pagesWithoutText: [4], ocr: { status: 'completed', totalPages: 3, completedPages: 3, pages: [2, 3] } }} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('OCR 提取文字的页码：2-3');
    expect(note).toHaveTextContent('未提取页码：4');
    expect(note).toHaveTextContent('不显示文字高亮');
  });

  it('reports OCR progress, disabled tools and an unpublished failed attempt', () => {
    const summary = { totalPages: 2, textPages: 0, pagesWithoutText: [1, 2], ocr: { status: 'running' as const, totalPages: 2, completedPages: 1, pages: [] } };
    const { rerender } = render(<PdfTextNotice summary={summary} />);
    expect(screen.getByRole('status')).toHaveTextContent('已识别 1 / 2 页');
    rerender(<PdfTextNotice summary={{ ...summary, ocr: { ...summary.ocr, status: 'timeout' } }} />);
    expect(screen.getByRole('note')).toHaveTextContent('识别结果尚未发布');
    rerender(<PdfTextNotice summary={{ ...summary, ocr: { ...summary.ocr, status: 'disabled' } }} />);
    expect(screen.getByRole('note')).toHaveTextContent('管理员启用 OCR 后可重新处理');
  });
  it('does not infer complete extraction from missing historical data', () => {
    const { rerender } = render(<PdfTextNotice />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    rerender(<PdfTextNotice summary={null} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    rerender(<PdfTextNotice summary={{ totalPages: 3, textPages: 3, pagesWithoutText: [] }} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('shows physical page ranges and avoids diagnosing scans as corruption', () => {
    render(<PdfTextNotice summary={{ totalPages: 10, textPages: 6, pagesWithoutText: [2, 3, 4, 8] }} />);
    const note = screen.getByRole('note', { name: 'PDF 文字提取情况' });
    expect(note).toHaveTextContent('共 10 页，其中 4 页未提取到文字');
    expect(note).toHaveTextContent('未提取页码：2-4、8');
    expect(note).toHaveTextContent('可能是空白页或扫描图片');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lets the reader expand large page lists and clears the old result on retry', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PdfTextNotice summary={{ totalPages: 50, textPages: 25, pagesWithoutText: Array.from({ length: 25 }, (_, index) => index * 2 + 1) }} />);
    const toggle = screen.getByText('查看全部页码');
    expect(toggle.closest('details')).not.toHaveAttribute('open');
    await user.click(toggle);
    expect(toggle.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/未提取页码/)).toHaveTextContent('45、47、49');
    rerender(<PdfTextNotice summary={null} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
