import type { DocumentErrorCode, DocumentItem } from '../../types/api';
import { getDocumentProcessingErrorMessage } from '../../utils/errors';

/**
 * What to show for a failed document.
 *
 * `reason` says what went wrong, `advice` says what to do about it. They are
 * separate because the reason is often enough on its own -- a cancelled job needs
 * no instructions -- and merging them produces sentences that tell the user to fix
 * something the server already knows is not their fault.
 */
export type DocumentFailureCopy = {
  reason: string;
  advice: string;
  /** True when retrying without changing the file has a real chance of working. */
  retryable: boolean;
};

const FAILURES: Record<DocumentErrorCode, DocumentFailureCopy> = {
  pdf_limit_exceeded: { reason: 'PDF 超出解析限制。', advice: '请拆分为最多 500 页、8 MiB 解析文本的文件后重新上传。', retryable: false },
  ocr_unavailable: { reason: '扫描 PDF 识别工具或语言包不可用。', advice: '请联系管理员检查 OCR 工具和语言包，配置完成后重新处理。', retryable: true },
  ocr_timeout: { reason: '扫描 PDF 识别超时。', advice: '请拆分文件或联系管理员调整识别时限后重新处理。', retryable: true },
  ocr_failed: { reason: '扫描 PDF 的页面识别失败。', advice: '请检查原文件能否正常打开，并联系管理员检查识别工具后重新处理。', retryable: true },
  ocr_limit_exceeded: { reason: '扫描 PDF 超出识别资源限制。', advice: '请拆分文件后重新上传；默认每份最多识别 40 页，管理员可调整至最多 200 页。', retryable: false },
  table_limit_exceeded: { reason: '表格超出解析限制。', advice: '请拆分至最多 32 个工作表、合计 10000 条数据行、256 列和 8 MiB 解析文本；单元格最多 32767 字，CSV 物理行数或工作表行号最多 100000。', retryable: false },
  table_import_invalid: { reason: '表格导入设置与文件不匹配。', advice: '请重新导入并检查所选工作表、表头行和列是否存在。', retryable: false },
  unsupported_type: {
    reason: '文件格式不受支持。',
    advice: '转换成 TXT、Markdown、PDF、DOCX、XLSX 或 UTF-8 CSV 后重新上传。',
    retryable: false,
  },
  corrupt_file: {
    reason: '文件无法解析，可能已损坏或上传不完整。',
    advice: '在本地打开确认文件正常后重新上传。',
    retryable: false,
  },
  encoding_invalid: {
    reason: '文本编码无法识别。',
    advice: '用 UTF-8 编码另存后重新上传。',
    retryable: false,
  },
  empty_content: {
    // The most common real cause is a scanned PDF, and saying so saves the user
    // from re-uploading the same image-only file and getting the same result.
    reason: '文件里没有可提取的文字，扫描件或纯图片 PDF 通常是这种情况。',
    advice: '请核对原文件是否为空白；扫描件可由管理员启用 OCR 后重新处理，或改上传文字版本。',
    retryable: false,
  },
  embedding_failed: {
    reason: '向量化调用失败，文件本身没有问题。',
    advice: '稍后重新处理；如果一直失败，请检查模型服务状态。',
    retryable: true,
  },
  storage_failed: {
    reason: '读取文件时存储服务不可用。',
    advice: '稍后重新处理即可，不需要重新上传。',
    retryable: true,
  },
  cancelled: {
    reason: '处理已取消。',
    advice: '需要的话可以重新处理。',
    retryable: true,
  },
  internal: {
    reason: '处理过程中出现未预期的错误。',
    advice: '可以重新处理一次；如果重复失败，请把文件名提供给管理员排查。',
    retryable: true,
  },
};

/**
 * Copy for a failed document, falling back to neutral wording.
 *
 * An unknown code means the server was upgraded ahead of the browser. Guessing a
 * specific cause there would send the user to fix the wrong thing, so the fallback
 * says only what is certain -- it failed, retrying is allowed -- and keeps the
 * server's own sentence when there is one.
 */
export function documentFailureCopy(
  document: Pick<DocumentItem, 'errorCode' | 'errorMessage'> & Partial<Pick<DocumentItem, 'fileType'>>,
): DocumentFailureCopy {
  const code = document.errorCode;
  if (code === 'empty_content' && (document.fileType === 'xlsx' || document.fileType === 'csv')) {
    return {
      reason: '表格中没有可入库的数据行。',
      advice: document.fileType === 'xlsx'
        ? '首个非空行为表头，请在其后补充数据；公式需要先在表格软件中计算并保存结果，再重新上传。'
        : '首个非空记录为表头，请在其后补充数据后重新上传。',
      retryable: false,
    };
  }
  if (code && code in FAILURES) {
    return FAILURES[code as DocumentErrorCode];
  }
  return {
    reason: getDocumentProcessingErrorMessage(document.errorMessage),
    advice: '可以重新处理一次；如果重复失败，请联系管理员排查。',
    retryable: true,
  };
}

/**
 * The staleness hint, or null when it does not apply.
 *
 * Phrased as a possibility with the threshold named, because age is not evidence
 * of being wrong: a policy from two years ago may well still be current. The
 * threshold is echoed so the user can tell whether the flag means anything for
 * their content rather than having to trust it.
 */
export function documentStalenessHint(
  document: Pick<DocumentItem, 'isStale' | 'staleAfterDays'>,
): string | null {
  if (!document.isStale) return null;
  const days = document.staleAfterDays ?? 0;
  return days > 0
    ? `超过 ${days} 天没有更新，内容可能已过期。`
    : '内容可能已过期。';
}
