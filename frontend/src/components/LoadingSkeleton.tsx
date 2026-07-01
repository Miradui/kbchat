type LoadingSkeletonProps = {
  rows?: number;
  columns?: number;
  compact?: boolean;
};

export function LoadingSkeleton({ rows = 3, columns = 3, compact = false }: LoadingSkeletonProps) {
  return (
    <div className={compact ? 'skeleton-stack compact' : 'skeleton-stack'} aria-label="正在加载">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
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
