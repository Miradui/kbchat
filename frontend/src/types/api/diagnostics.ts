export type SystemDependencyState = 'ok' | 'degraded' | 'down' | 'not_configured';

/**
 * The closed reason set the server may return. It carries no error text, host or
 * connection string by design, so the UI maps codes to copy rather than
 * displaying whatever arrives.
 */
export type SystemFailureReason =
  | 'timeout'
  | 'unreachable'
  | 'auth_rejected'
  | 'not_configured'
  | 'not_found'
  | 'unavailable';

export type SystemDependencyStatus = {
  name: string;
  status: SystemDependencyState;
  reason?: string;
  latencyMs: number | null;
};

export type SystemProviderStatus = {
  name: string;
  configured: boolean;
  model?: string;
  status: SystemDependencyState;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason?: string;
  successCount: number;
  failureCount: number;
  recentFailures: number;
};

export type SystemDocumentQueueStatus = {
  pending: number;
  running: number;
  failed: number;
  completed: number;
  cancelled: number;
  oldestPendingSeconds: number | null;
  oldestRunningSeconds: number | null;
  failureWindowHours: number;
  finishedInWindow: number;
  failedInWindow: number;
  /** Null when the window holds no finished jobs, which is not a zero rate. */
  recentFailureRate: number | null;
};

export type SystemCleanupQueueStatus = {
  backlog: number;
  retrying: number;
  locked: number;
  oldestPendingSeconds: number | null;
};

export type SystemLatencyMetric = {
  metric: string;
  count: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type SystemEmbeddingCacheMetrics = {
  hits: number;
  misses: number;
  errors: number;
  /** Null until this process has observed at least one cache hit or miss. */
  hitRate: number | null;
};

export type SystemVectorSearchStatus = {
  /** Empty when the version could not be read. */
  pgvectorVersion: string;
  /** pgvector 0.8.0 and later keep scanning the HNSW index until the page is full. */
  iterativeScan: boolean;
  /** Searches since restart whose approximate scan was rerun exhaustively. */
  exactFallbacks: number;
};

export type SystemEmbeddingStatus = {
  status: SystemDependencyState; model: string; configuredDimension: number; columnDimension: number | null;
  totalDocuments: number; unknownDocuments: number; mismatchedDocuments: number;
  groups: Array<{ model: string | null; dimension: number | null; count: number }>;
};

export type SystemDiagnostics = {
  status: SystemDependencyState;
  checkedAt: string;
  env: string;
  dependencies: SystemDependencyStatus[];
  queues: {
    documents: SystemDocumentQueueStatus;
    cleanup: SystemCleanupQueueStatus;
  };
  providers: SystemProviderStatus[];
  latency: SystemLatencyMetric[];
  rerankFallbacks: Record<string, number>;
  rateLimitTriggers: Record<string, number>;
  embeddingCache: SystemEmbeddingCacheMetrics;
  vectorSearch: SystemVectorSearchStatus;
  embedding?: SystemEmbeddingStatus;
  /** Latency, fallback, rate-limit and cache counters reset on restart. */
  metricsSinceRestart: boolean;
};
