type LoadingSkeletonProps = {
  rows?: number;
  columns?: number;
  compact?: boolean;
  announce?: boolean;
  label?: string;
};

export function LoadingSkeleton({
  rows = 3,
  columns = 3,
  compact = false,
  announce = false,
  label = '正在加载',
}: LoadingSkeletonProps) {
  return (
    <div
      aria-atomic={announce || undefined}
      aria-hidden={announce ? undefined : true}
      aria-label={announce ? label : undefined}
      aria-live={announce ? 'polite' : undefined}
      className={compact ? 'skeleton-stack compact' : 'skeleton-stack'}
      role={announce ? 'status' : undefined}
    >
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          aria-hidden="true"
          className="skeleton-row"
          key={rowIndex}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <span className="skeleton-line" key={columnIndex} />
          ))}
        </div>
      ))}
    </div>
  );
}
