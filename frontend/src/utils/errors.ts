import { ApiError } from '../api/client';

export function getErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }

  const messages: Record<string, string> = {
    CHAT_COMPLETION_FAILED: '回答生成失败，请稍后重试。',
    EMBEDDING_FAILED: '知识检索暂时不可用，请稍后重试。',
    RERANK_FAILED: '知识检索排序暂时不可用，请稍后重试。',
    CHAT_MESSAGE_CHANGED: '会话已在其他窗口更新，请刷新后再编辑。',
    CHAT_EDIT_UNCONFIRMED: '编辑结果暂未确认，已保留原请求编号。请刷新会话后再试。',
    DOCUMENT_PROCESS_FAILED: '文档处理失败，请检查文件内容或稍后重处理。',
    INTERNAL_ERROR: fallback,
  };
  const message = messages[error.code] ?? (isTechnicalError(error.message) ? fallback : error.message);
  return error.status >= 500 && error.traceId
    ? `${message}（追踪编号：${error.traceId}）`
    : message;
}

function isTechnicalError(message: string): boolean {
  return [
    /(?:api[_ ]?key|base[_ ]?url|model)\s+is required/i,
    /\b(?:chat completion|embedding|rerank|retrieval)\s+failed\b/i,
    /\b(?:dial tcp|connection refused|connect\s+econn|timeout)\b/i,
  ].some((pattern) => pattern.test(message));
}

export function getDocumentProcessingErrorMessage(errorMessage: string | null | undefined): string {
  const normalized = errorMessage?.trim().toLowerCase() ?? '';
  if (
    normalized.includes('尚未配置完成') ||
    normalized.includes('api_key is required') ||
    normalized.includes('api key is required') ||
    normalized.includes('base_url is required') ||
    normalized.includes('base url is required') ||
    normalized.includes('model is required')
  ) {
    return '文档处理服务尚未配置完成，请联系管理员完成配置后再重处理。';
  }
  return '文档处理失败，请检查文件内容或稍后重处理。';
}
