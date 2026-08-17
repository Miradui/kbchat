import { ChevronLeft, ChevronRight } from 'lucide-react';

type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

/**
 * Builds `1 … 4 5 6 … 12`. Always shows first and last page so the user can
 * tell how deep the list goes without stepping through it.
 */
export function pageWindow(page: number, totalPages: number): Array<number | 'gap'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const items: Array<number | 'gap'> = [1];
  const start = Math.max(2, Math.min(page - 1, totalPages - 4));
  const end = Math.min(totalPages - 1, Math.max(page + 1, 5));

  if (start > 2) items.push('gap');
  for (let value = start; value <= end; value += 1) items.push(value);
  if (end < totalPages - 1) items.push('gap');
  items.push(totalPages);

  return items;
}

export function Pagination({
  page,
  pageSize,
  total,
  pageSizeOptions = [10, 20, 50],
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  return (
    <nav aria-label="分页" className="ui-pagination">
      <span className="ui-pagination__total">共 {total} 条</span>
      <div className="ui-pagination__pages">
        <button
          aria-label="上一页"
          className="ui-pagination__page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          type="button"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        {pageWindow(page, totalPages).map((item, index) => (
          item === 'gap' ? (
            <span aria-hidden="true" className="ui-pagination__gap" key={`gap-${index}`}>…</span>
          ) : (
            <button
              aria-current={item === page ? 'page' : undefined}
              aria-label={`第 ${item} 页`}
              className="ui-pagination__page"
              key={item}
              onClick={() => onPageChange(item)}
              type="button"
            >
              {item}
            </button>
          )
        ))}
        <button
          aria-label="下一页"
          className="ui-pagination__page"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          type="button"
        >
          <ChevronRight aria-hidden="true" />
        </button>
        {onPageSizeChange && (
          <select
            aria-label="每页数量"
            className="ui-select"
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            value={pageSize}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>{option} 条/页</option>
            ))}
          </select>
        )}
      </div>
    </nav>
  );
}
