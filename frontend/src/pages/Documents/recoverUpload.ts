import { ApiError } from '../../api/client';
import type { DocumentUploadResult } from '../../api/resources';
import type { DocumentItem } from '../../types/api';

export function isUnconfirmedUpload(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

/** Reconcile before resending; both sends carry the same server-side key. */
export async function recoverUpload({ send, check, signal, reconcileFirst, onReconciling }: {
  send: () => Promise<DocumentItem>;
  check: () => Promise<DocumentUploadResult>;
  signal: AbortSignal;
  reconcileFirst: boolean;
  onReconciling: () => void;
}): Promise<DocumentItem> {
  async function reconcile() {
    signal.throwIfAborted();
    onReconciling();
    const result = await check();
    signal.throwIfAborted();
    if (result.status === 'unavailable') throw new ApiError(409, { code: 'DOCUMENT_UPLOAD_RESULT_UNAVAILABLE', message: '该请求已上传成功，但文档已删除、移动或不可访问。请刷新文档列表。' });
    return result.status === 'committed' ? result.document : null;
  }
  if (reconcileFirst) {
    const document = await reconcile();
    if (document) return document;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();
    try { return await send(); }
    catch (error) {
      if (signal.aborted || !isUnconfirmedUpload(error)) throw error;
      const document = await reconcile();
      if (document) return document;
      if (attempt === 1) throw error;
    }
  }
  throw new Error('上传结果待确认');
}
